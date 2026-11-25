[CmdletBinding()]
param([switch]$ReplaceReviewedPublicFiles)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$state=Join-Path $repo '.installation/windows-test'
if(-not(Test-Path -LiteralPath (Join-Path $state 'prepared.marker'))){throw 'Existing installation required.'}
if(Test-Path -LiteralPath (Join-Path $state 'operations.lock')){throw 'Another installation operation is in progress.'}
if(Test-Path -LiteralPath (Join-Path $state 'build.lock')){throw 'Complete the current build before preparing public PKI.'}
$reviewed=Join-Path $PSScriptRoot 'public-pki'
$verifier=Join-Path $repo 'scripts/verify-public-fiscal-pki.cjs'
$pki=Join-Path $state 'pki'
$names=@('issuer-roots.pem','crls.pem','cdr-signers.pem')
if(-not $ReplaceReviewedPublicFiles){foreach($name in $names){if(Test-Path -LiteralPath (Join-Path $pki $name)){throw 'Public PKI already exists. Review it before using -ReplaceReviewedPublicFiles.'}}}
$staging=Join-Path $state ('public-pki-staging-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri 'https://crl.llama.pe/llamaperootca.crl' -OutFile (Join-Path $staging 'root.crl')
Invoke-WebRequest -UseBasicParsing -Uri 'https://crl.llama.pe/llamapestandardca.crl' -OutFile (Join-Path $staging 'intermediate.crl')
# The network-free verifier reads only public inputs and writes only this staging directory.
& docker --context desktop-linux run --rm --pull never --network none --user 0:0 --mount "type=bind,source=$staging,target=/pki" --mount "type=bind,source=$reviewed,target=/reviewed,readonly" --mount "type=bind,source=$verifier,target=/verify-public-fiscal-pki.cjs,readonly" --entrypoint node factuez-windows-test/sunat-service:local /verify-public-fiscal-pki.cjs /pki /reviewed
if($LASTEXITCODE -ne 0){throw 'Public PKI verification failed. Existing files retained; inspect staging.'}
$report=Get-Content -LiteralPath (Join-Path $staging 'verification.json') -Raw | ConvertFrom-Json
if($report.verified -ne $true -or [DateTime]::Parse($report.crlExpiresAt).ToUniversalTime() -le [DateTime]::UtcNow){throw 'Verified current public PKI required.'}
New-Item -ItemType Directory -Force -Path $pki | Out-Null
if($ReplaceReviewedPublicFiles){
 $backup=Join-Path $staging 'previous-public-files';New-Item -ItemType Directory -Path $backup | Out-Null
 foreach($name in $names){$old=Join-Path $pki $name;if(Test-Path -LiteralPath $old){Copy-Item -LiteralPath $old -Destination (Join-Path $backup $name)}}
}
foreach($name in $names){
 $source=Join-Path $staging $name
 if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.hashes.$name){throw 'Verified public file changed.'}
 Copy-Item -LiteralPath $source -Destination (Join-Path $pki $name)
}
Copy-Item -LiteralPath (Join-Path $staging 'verification.json') -Destination (Join-Path $pki 'last-verification.json')
Write-Host ('PUBLIC_PKI_PREPARED; CRL expires UTC: '+$report.crlExpiresAt)
Write-Host 'Existing vault/JWT/fiscal private keys retained. No transmission activated.'
if($ReplaceReviewedPublicFiles){Write-Host 'Public files refreshed. Reapply the reviewed server gates to update the matching runtime hashes; old pins remain fail-closed until that deployment.'}
