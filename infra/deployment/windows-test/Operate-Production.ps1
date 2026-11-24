[CmdletBinding()]
param(
 [ValidateSet('Status','Start','Build','CheckUpdate','Update','Backup','VerifyBackup','RestoreBackup','DisableBootstrap','ProvisionGre','EnableGre','DisableGre','EnableProduction','DisableProduction')][string]$Action='Status',
 [string]$TransmissionConfirmation='', [string]$BackupPath='', [string]$ExternalDestination='',
 [switch]$ExternalDestinationReviewed, [string]$RecoveryPath='', [string]$RecoveryProject='', [string]$ReadinessSessionFile='', [string]$DockerDiskPath=''
)
$ErrorActionPreference='Stop'
# Production is an operational entrypoint, never a different Compose project or a fiscal bypass.
if($Action -in @('Status','Backup','VerifyBackup','RestoreBackup','Update')){
 & (Join-Path $PSScriptRoot 'Windows-Operations.ps1') -Action $Action -BackupPath $BackupPath -ExternalDestination $ExternalDestination -ExternalDestinationReviewed:$ExternalDestinationReviewed -RecoveryPath $RecoveryPath -RecoveryProject $RecoveryProject -ReadinessSessionFile $ReadinessSessionFile -DockerDiskPath $DockerDiskPath
}else{
 & (Join-Path $PSScriptRoot 'Install-Test.ps1') -Action $Action -TransmissionConfirmation $TransmissionConfirmation
 if($Action -in @('Start','EnableProduction','DisableProduction','EnableGre','DisableGre','DisableBootstrap')){& (Join-Path $PSScriptRoot 'Windows-Operations.ps1') -Action Status}
}
