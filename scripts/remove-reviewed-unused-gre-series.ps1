#requires -Version 5.1
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$SnapshotPath,
 [Parameter(Mandatory=$true)][string]$ReviewSha256,
 [Parameter(Mandatory=$true)][string]$BackupPath,
 [Parameter(Mandatory=$true)][string]$Confirmation
)
$ErrorActionPreference='Stop'
$stage='explicit-review';$recoveryPath=$null;$writeAttempted=$false;$commitConfirmed=$false
try {
 if($Confirmation -cne 'DELETE UNUSED T099 BETA AND T100 PRODUCTION FOR 20600979630' -or $ReviewSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'REVIEW_REQUIRED'}
 $review=[IO.File]::ReadAllText([IO.Path]::GetFullPath($SnapshotPath))|ConvertFrom-Json
 if($review.status -cne 'preview-only' -or $review.snapshot.version -cne 'factuez.gre-series-cleanup-preview.v2' -or $review.snapshot.issuerRuc -cne '20600979630'){throw 'REVIEW_INVALID'}
 $canonical=$review.snapshot|ConvertTo-Json -Depth 10 -Compress
 $hash=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual -cne $ReviewSha256 -or $review.reviewSha256 -cne $actual){throw 'REVIEW_CHANGED'}
 $stage='verified-backup'
 $backup=[IO.Path]::GetFullPath($BackupPath)
 $manifestPath=Join-Path $backup 'manifest.json'
 $manifest=[IO.File]::ReadAllText($manifestPath)|ConvertFrom-Json
 $backupSha=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
 if($manifest.project -cne 'factuez-san-jose-test' -or $manifest.status -cne 'COMPLETE' -or $manifest.restoreValidation -cne 'ALL_FIVE_DATABASES_RESTORED' -or -not(Test-Path -LiteralPath (Join-Path $backup 'COMPLETE')) -or [IO.File]::ReadAllText((Join-Path $backup 'manifest.sha256')).Trim() -cne $backupSha){throw 'BACKUP_NOT_VERIFIED'}
 # Existing verifier checks every backup hash; capture its messages, never dump them.
 $verification=@(& (Join-Path $PSScriptRoot '../infra/deployment/windows-test/Operate-Production.ps1') -Action VerifyBackup -BackupPath $backup 6>&1)
 if(@($verification|Where-Object{$_.ToString() -ceq 'OFFLINE_BACKUP_HASHES_VERIFIED'}).Count -ne 1){throw 'BACKUP_NOT_VERIFIED'}
 $stage='save-recovery-snapshot'
 $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
 $recoveryPath=Join-Path $root ('.installation/windows-test/recovery/gre-series-delete-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N'))
 [void](New-Item -ItemType Directory -Path $recoveryPath)
 $utf8=New-Object Text.UTF8Encoding($false)
 [IO.File]::WriteAllText((Join-Path $recoveryPath 'before.json'),($review|ConvertTo-Json -Depth 12),$utf8)
 [IO.File]::WriteAllText((Join-Path $recoveryPath 'backup-proof.json'),([pscustomobject]@{manifestSha256=$backupSha;backupCreatedUtc=$manifest.createdUtc;backupPath=$backup;reviewSha256=$actual}|ConvertTo-Json -Depth 4),$utf8)
 $stage='postgres-discovery'
 . (Join-Path $PSScriptRoot 'diagnose-gre-series.ps1')
 $answer=Invoke-GreSeriesDocker -Arguments @('--context','desktop-linux','ps','--filter','label=com.docker.compose.project=factuez-san-jose-test','--filter','label=com.docker.compose.service=postgres','--format','{{.ID}}')
 if($answer.exitCode -ne 0){throw 'EXACT_POSTGRES_REQUIRED'}
 $ids=@($answer.stdout -split '\r?\n'|Where-Object{$_.Trim().Length -gt 0})
 if($ids.Count -ne 1 -or $ids[0] -cnotmatch '^[a-f0-9]{12,64}$'){throw 'EXACT_POSTGRES_REQUIRED'}
 $stage='locked-conditional-delete'
 $plan=[pscustomobject]@{snapshot=$review.snapshot;backupSha256=$backupSha}|ConvertTo-Json -Depth 12 -Compress
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plan))
 $inputSql="DO `$input`$ BEGIN PERFORM set_config('factuez.gre.cleanup.reviewed',convert_from(decode('"+$encoded+"','base64'),'UTF8'),true); END `$input`$;"
 $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'gre-series-cleanup-reviewed.sql')).Replace('-- REVIEWED_INPUT_REQUIRED',$inputSql)
 $writeAttempted=$true
 $answer=Invoke-GreSeriesDocker -Arguments @('--context','desktop-linux','exec','-i',$ids[0],'psql','-X','--no-password','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','factuez_billing') -InputText $sql
 if($answer.exitCode -ne 0){
  $code='GRE_CLEANUP_COMMIT_STATUS_UNCONFIRMED';$status='uncertain'
  if($answer.exitCode -eq 3){$status='blocked';$code='GRE_CLEANUP_TRANSACTION_ABORTED'}
  foreach($allowed in @('GRE_CLEANUP_REVIEW_REQUIRED','GRE_CLEANUP_EXACT_TWO_REQUIRED','GRE_CLEANUP_SNAPSHOT_CHANGED_OR_USED','GRE_CLEANUP_REFERENCES_EXIST','GRE_CLEANUP_HISTORY_EXISTS','GRE_CLEANUP_DELETE_COUNT_MISMATCH','GRE_CLEANUP_AUDIT_REVIEW_REQUIRED','GRE_CLEANUP_AUDIT_SNAPSHOT_CHANGED','GRE_CLEANUP_AUDIT_CONTRACT_CHANGED','GRE_CLEANUP_AUDIT_NOT_PRESERVED')){if($answer.stderr.Contains($allowed)){$code=$allowed;break}}
  [pscustomobject]@{status=$status;stage=$stage;code=$code;recoveryPath=$recoveryPath}|ConvertTo-Json -Compress
  exit 1
 }
 $rows=@($answer.stdout -split '\r?\n'|Where-Object{$_.Trim().StartsWith('{')})
 if($rows.Count -ne 1){throw 'COMMITTED_RESULT_REQUIRES_RECONCILIATION'}
 $receipt=$rows[0]|ConvertFrom-Json
 if($receipt.status -cne 'deleted' -or $receipt.version -cne 'factuez.gre-series-cleanup-receipt.v2' -or $receipt.issuerRuc -cne '20600979630' -or $receipt.rows.Count -ne 2){throw 'COMMITTED_RESULT_REQUIRES_RECONCILIATION'}
 $commitConfirmed=$true
 [IO.File]::WriteAllText((Join-Path $recoveryPath 'deleted.json'),($receipt|ConvertTo-Json -Depth 10),$utf8)
 [pscustomobject]@{status='deleted';version=$receipt.version;rows=$receipt.rows;preservedCreationAudit=$receipt.preservedCreationAudit;recoveryPath=$recoveryPath;backupSha256=$backupSha;reviewSha256=$actual}|ConvertTo-Json -Depth 12 -Compress
}catch{
 $status='failed';$code='GRE_CLEANUP_NOT_STARTED'
 if($writeAttempted){$status='uncertain';$code='GRE_CLEANUP_COMMIT_STATUS_UNCONFIRMED'}
 if($commitConfirmed){$status='committed-receipt-not-saved';$code='GRE_CLEANUP_RECOVERY_RECEIPT_FAILED'}
 [pscustomobject]@{status=$status;stage=$stage;code=$code;recoveryPath=$recoveryPath}|ConvertTo-Json -Compress
 exit 1
}
