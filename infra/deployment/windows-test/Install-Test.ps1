[CmdletBinding()]
param([ValidateSet('Build','Prepare','Start','Status','Stop','DisableBootstrap')][string]$Action='Status')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$state=Join-Path $projectRoot '.installation/windows-test'
$envFile=Join-Path $state 'public.env'
$composeFile=Join-Path $PSScriptRoot 'docker-compose.yml'
$project='factuez-san-jose-test'
$utf8=New-Object Text.UTF8Encoding($false)
function Invoke-Docker([string[]]$Arguments) { & docker @Arguments; if($LASTEXITCODE -ne 0){throw 'Docker operation failed. Do not delete volumes or regenerate secrets.'} }
function Invoke-Compose([string[]]$Arguments) { if(-not(Test-Path -LiteralPath $envFile)){throw 'Run Prepare first.'}; Invoke-Docker (@('compose','--project-name',$project,'--env-file',$envFile,'--file',$composeFile)+$Arguments) }
if($env:OS -ne 'Windows_NT'){throw 'Windows 11 required for this launcher.'}
$dockerOs=& docker info --format '{{.OSType}}'
if($LASTEXITCODE -ne 0 -or $dockerOs.Trim() -ne 'linux'){throw 'Start Docker Desktop in Linux containers mode first.'}
if($Action -eq 'Build') {
 foreach($service in @('identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa')) {
  $argsList=@('build','--platform','linux/amd64','--tag',('factuez-windows-test/'+$service+':local'))
  if($service -eq 'web-pwa'){$argsList+=@('--file','docker/Dockerfile.web-pwa','--build-arg','NEXT_PUBLIC_API_BASE_URL=','--build-arg','NEXT_PUBLIC_B2B_ADMIN_PROFILE=SSO')}
  else{$argsList+=@('--file','docker/Dockerfile.service','--build-arg',('SERVICE_NAME=@factuez/'+$service),'--build-arg',('SERVICE_PATH=services/'+$service))}
  Push-Location $projectRoot;try{Invoke-Docker ($argsList+@('.'))}finally{Pop-Location}
 };return
}
if($Action -eq 'Prepare') {
 foreach($image in @('identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa')) { Invoke-Docker -Arguments @('image','inspect',('factuez-windows-test/'+$image+':local'),'--format','{{.Id}}') }
 if(Test-Path -LiteralPath $state){throw 'Installation state exists. Never regenerate keys on an initialized installation.'}
 $priorVolumes=@(& docker volume ls --quiet --filter "label=com.docker.compose.project=$project");if($LASTEXITCODE -ne 0 -or $priorVolumes.Count -gt 0){throw 'Existing volumes found. This preparation is for a new installation only.'}
 $username=Read-Host 'First administrator username (example: admin.sanjose)'
 if($username -notmatch '^[a-z][a-z0-9._-]{2,79}$'){throw 'Invalid username.'}
 $fullName=Read-Host 'Administrator full name'
 if($fullName -notmatch '^[\p{L}\p{N} ._-]{3,100}$'){throw 'Use a name of 3-100 letters/numbers without special symbols.'}
 $p1=Read-Host 'Administrator password (12-256 characters)' -AsSecureString
 $p2=Read-Host 'Confirm administrator password' -AsSecureString
 $b1=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1);$b2=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
 try{$plain1=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1);$plain2=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2);if($plain1 -cne $plain2 -or $plain1.Length -lt 12 -or $plain1.Length -gt 256 -or $plain1.Trim() -cne $plain1){throw 'Passwords must match and must not start/end with whitespace.'}
  New-Item -ItemType Directory -Path $state | Out-Null
  $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $state /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not protect the installation directory.'}
  $secrets=Join-Path $state 'secrets';New-Item -ItemType Directory -Path $secrets | Out-Null
  [IO.File]::WriteAllText((Join-Path $secrets 'initial_admin_password'),$plain1+"`n",$utf8)
 }finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1);[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2);$plain1=$null;$plain2=$null}
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{foreach($name in @('postgres_admin_password','identity_db_password','billing_db_password','sunat_db_password','mailer_db_password','received_db_password','redis_password','internal_service_token','app_master_key','smtp_settings_key','reception_settings_key','production_notes_owner_key')){$bytes=New-Object byte[] 32;$rng.GetBytes($bytes);$hex=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant();[IO.File]::WriteAllText((Join-Path $secrets $name),$hex+"`n",$utf8)}}finally{$rng.Dispose()}
 $redisPassword=[IO.File]::ReadAllText((Join-Path $secrets 'redis_password')).Trim();$hash=[Security.Cryptography.SHA256]::Create();try{$redisHash=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($redisPassword)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose();$redisPassword=$null}
 [IO.File]::WriteAllText((Join-Path $secrets 'redis_acl'),"user default on #${redisHash} ~* &* +@all`n",$utf8)
 [IO.File]::WriteAllText($envFile,"FIRST_ADMIN_USERNAME=${username}`nFIRST_ADMIN_FULL_NAME=${fullName}`n",$utf8)
 $keyScript="const fs=require('node:fs'),c=require('node:crypto');const k=c.generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});fs.writeFileSync('/install/secrets/jwt_private_key',k.privateKey,{flag:'wx',mode:0o600});fs.writeFileSync('/install/secrets/jwt_public_key',k.publicKey,{flag:'wx',mode:0o600});"
 Invoke-Docker -Arguments @('run','--rm','--network','none','--mount',"type=bind,source=$state,target=/install",'--entrypoint','node','factuez-windows-test/identity-service:local','-e',$keyScript)
 $scriptsPath=Join-Path $projectRoot 'scripts'
 Invoke-Docker -Arguments @('run','--rm','--network','none','--mount',"type=bind,source=$state,target=/install",'--mount',"type=bind,source=$scriptsPath,target=/workspace/scripts,readonly",'--entrypoint','node','factuez-windows-test/identity-service:local','scripts/export-windows-test-schemas.cjs','/install/schemas')
 [IO.File]::WriteAllText((Join-Path $state 'prepared.marker'),"NEW_WINDOWS_TEST_INSTALLATION`n",$utf8)
 Write-Host 'Prepared. Password was not printed. Continue with Start.';return
}
if($Action -eq 'Start') {
 if(-not(Test-Path -LiteralPath (Join-Path $state 'prepared.marker'))){throw 'Preparation incomplete; do not start.'}
 $listener=Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction SilentlyContinue
 $existing=@(& docker ps -q --filter "label=com.docker.compose.project=$project")
 if($listener -and $existing.Count -eq 0){throw 'Port 8091 is occupied by another application.'}
 Invoke-Compose -Arguments @('up','--detach','--no-build','--wait','--wait-timeout','300');Write-Host 'Open http://localhost:8091/login';return
}
if($Action -eq 'DisableBootstrap') {
 if(-not(Test-Path -LiteralPath $envFile)){throw 'Installation not prepared.'}
 $text=[IO.File]::ReadAllText($envFile);$text=[regex]::Replace($text,'(?m)^FIRST_ADMIN_USERNAME=.*$','FIRST_ADMIN_USERNAME=');[IO.File]::WriteAllText($envFile,$text,$utf8)
 Invoke-Compose -Arguments @('up','--detach','--no-deps','--no-build','--wait','--wait-timeout','120','identity-service');Write-Host 'Initial account bootstrap disabled. Existing account/password retained.';return
}
if($Action -eq 'Stop'){Invoke-Compose -Arguments @('stop','--timeout','90');return}
Invoke-Compose -Arguments @('ps')
