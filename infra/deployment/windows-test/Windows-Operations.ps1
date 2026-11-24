[CmdletBinding()]
param(
 [ValidateSet('Status','Backup','VerifyBackup','RestoreBackup','Update','RecordRelease','CheckImages')][string]$Action='Status',
 [string]$BackupPath='', [string]$ExternalDestination='', [switch]$ExternalDestinationReviewed,
 [string]$RecoveryPath='', [string]$RecoveryProject='', [string]$ReadinessSessionFile='',
 [string]$InstallationPath='', [string]$ComposePath='', [string]$ProjectName='factuez-san-jose-test',
 [switch]$SyntheticScope, [string]$DockerDiskPath=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if(-not $InstallationPath){$InstallationPath=Join-Path $root '.installation/windows-test'}
if(-not $ComposePath){$ComposePath=Join-Path $PSScriptRoot 'docker-compose.yml'}
$state=[IO.Path]::GetFullPath($InstallationPath)
$compose=[IO.Path]::GetFullPath($ComposePath)
$utf8=New-Object Text.UTF8Encoding($false)
$databases=@('identity','billing','sunat','mailer','received')
$persistent=@('redis_data','billing_service_print_branding','sunat_service_artifacts','sunat_service_private','web_pwa_cache')
$label='factuez.recovery.scope'
$run=[guid]::NewGuid().ToString('N')
$logPath=$null
function Write-Json($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30)+"`n",$utf8)}
function Read-Json($Path){Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json}
function Phase($Name){if($logPath){[IO.File]::AppendAllText($logPath,([DateTime]::UtcNow.ToString('o')+' phase='+$Name+"`n"),$utf8)}}
function Local-Get($Path,$Authorization=''){
 $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:8091'+$Path)
 $request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.Timeout=15000;$request.ReadWriteTimeout=15000
 if($Authorization){$request.Headers['Authorization']=$Authorization}
 $response=$null;$reader=$null
 try {
  $response=$request.GetResponse();$reader=New-Object IO.StreamReader($response.GetResponseStream())
  $buffer=New-Object char[] 1048577;$count=$reader.ReadBlock($buffer,0,$buffer.Length)
  if($count -gt 1048576){throw 'LOCAL_RESPONSE_TOO_LARGE'}
  @{statusCode=[int]$response.StatusCode;body=([string]::new($buffer,0,$count))}
 }finally{if($reader){$reader.Dispose()};if($response){$response.Close()}}
}
function Protect-Directory($Path){
 if($env:OS -ne 'Windows_NT'){throw 'Windows ACL enforcement required.'}
 $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 & icacls $Path /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect recovery directory ACL.'}
}
function Assert-MountPath($Path){if($Path -match '[,\r\n]'){throw 'Mount paths cannot contain commas or line breaks.'}}
function Docker([string[]]$Arguments){
 # Never print command arguments, environment, SQL, subprocess output or credential contents.
 $errFile=Join-Path ([IO.Path]::GetTempPath()) ('factuez-ops-'+$run+'-'+[guid]::NewGuid().ToString('N')+'.stderr')
 try {
  $prior=$ErrorActionPreference;$ErrorActionPreference='Continue'
  try{$result=@(& docker.exe --context desktop-linux @Arguments 2> $errFile);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$prior}
  if($logPath){[IO.File]::AppendAllText($logPath,((Get-Date).ToUniversalTime().ToString('o')+' docker '+$Arguments[0]+' exit='+$code+"`n"),$utf8)}
  if($code -ne 0){throw ('DOCKER_OPERATION_FAILED ('+$Arguments[0]+', exit '+$code+'). Check Docker Desktop, disk space, image availability and service state; raw output suppressed to protect secrets.')}
  return ($result -join "`n")
 }finally{if(Test-Path -LiteralPath $errFile){Remove-Item -LiteralPath $errFile -Force}}
}
function Compose([string[]]$Arguments){$files=@('--file',$compose);$networkFile=Join-Path $state 'network.override.json';if(Test-Path -LiteralPath $networkFile){$files+=@('--file',$networkFile)};Docker (@('compose','--project-name',$ProjectName,'--env-file',(Join-Path $state 'public.env'))+$files+$Arguments)}
function Containers {
 $ids=Docker @('ps','--all','--quiet','--filter',"label=com.docker.compose.project=$ProjectName")
 if(-not $ids){return @()}
 $parsed=(Docker (@('inspect')+@($ids -split '\s+')))|ConvertFrom-Json
 foreach($container in $parsed){$container}
}
function Assert-Installation {
 if($ProjectName -ne 'factuez-san-jose-test' -and (-not $SyntheticScope -or $ProjectName -notmatch '^factuez-qa-[a-f0-9]{12}$')){throw 'Existing stable project required; synthetic override requires a unique factuez-qa scope.'}
 foreach($file in @('prepared.marker','public.env','secrets')){if(-not(Test-Path -LiteralPath (Join-Path $state $file))){throw 'Installation state missing. Locate the existing installation; never Prepare/reset to repair it.'}}
 if(-not(Test-Path -LiteralPath $compose -PathType Leaf)){throw 'Compose file missing.'}
}
function Image($Container){if($Container.Image -notmatch '^sha256:[a-f0-9]{64}$'){throw 'Immutable image identity required.'};$Container.Image}
function Volume($Name){
 $ids=Docker @('volume','ls','--quiet','--filter',"label=com.docker.compose.project=$ProjectName",'--filter',"label=com.docker.compose.volume=$Name")
 if(-not $ids -or @($ids -split '\s+').Count -ne 1){throw ('Missing or ambiguous owned volume: '+$Name)}
 $v=Read-Volume $ids.Trim()
 if($v.Labels.'com.docker.compose.project' -ne $ProjectName -or $v.Labels.'com.docker.compose.volume' -ne $Name){throw 'Volume ownership mismatch.'}
 $v.Name
}
function Read-Volume($Name){$parsed=(Docker @('volume','inspect',$Name))|ConvertFrom-Json;$parsed[0]}
function MetadataFiles($Base){
 $prefix=$Base.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 $items=@(Get-ChildItem -LiteralPath $Base -Force -Recurse)
 foreach($f in $items){if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Recovery trees must not contain symlinks/junctions.'}}
 $excluded=@('manifest.json','manifest.sha256','COMPLETE','operations.log','FAILED.json')|ForEach-Object {Join-Path $Base $_}
 @($items|Where-Object {-not $_.PSIsContainer -and $_.FullName -notin $excluded}|ForEach-Object {
  [ordered]@{path=$_.FullName.Substring($prefix.Length).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
 }|Sort-Object {$_.path})
}
function Verify($Path,[switch]$Staging){
 $base=[IO.Path]::GetFullPath($Path)
 if(-not $Staging -and [IO.Path]::GetFileName($base) -match '\.incomplete$'){throw 'INCOMPLETE_BACKUP: interrupted operation directory.'}
 $required=@('manifest.json','manifest.sha256');if(-not $Staging){$required+='COMPLETE'}
 foreach($n in $required){if(-not(Test-Path -LiteralPath (Join-Path $base $n) -PathType Leaf)){throw 'INCOMPLETE_BACKUP: completion marker/manifest missing.'}}
 $manifest=Read-Json (Join-Path $base 'manifest.json')
 $hash=(Get-FileHash -LiteralPath (Join-Path $base 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
 if([IO.File]::ReadAllText((Join-Path $base 'manifest.sha256')).Trim() -cne $hash){throw 'MANIFEST_HASH_MISMATCH'}
 if(-not $Staging -and [IO.File]::ReadAllText((Join-Path $base 'COMPLETE')).Trim() -cne $hash){throw 'COMPLETION_HASH_MISMATCH'}
 if($manifest.version -ne 1 -or $manifest.status -ne 'COMPLETE' -or $manifest.restoreValidation -ne 'ALL_FIVE_DATABASES_RESTORED') {throw 'UNVERIFIED_BACKUP'}
 $actual=@(MetadataFiles $base)
 if($actual.Count -ne @($manifest.files).Count){throw 'BACKUP_INVENTORY_MISMATCH'}
 foreach($f in $actual){$expected=@($manifest.files|Where-Object {$_.path -ceq $f.path});if($expected.Count -ne 1 -or $expected[0].sha256 -cne $f.sha256 -or $expected[0].bytes -ne $f.bytes){throw ('BACKUP_HASH_MISMATCH: '+$f.path)}}
 foreach($db in $databases){if(-not(@($manifest.files.path) -contains ('databases/factuez_'+$db+'.dump'))){throw 'MISSING_DATABASE_DUMP'}}
 foreach($v in $persistent){if(-not(@($manifest.files.path) -contains ('volumes/'+$v+'.tar'))){throw 'MISSING_PERSISTENT_VOLUME'}}
 return $manifest
}
function Remove-OwnedContainer($Name){
 $parsed=(Docker @('inspect',$Name))|ConvertFrom-Json;$c=$parsed[0]
 if($c.Config.Labels.$label -ne $run -or $c.HostConfig.NetworkMode -ne 'none' -or @($c.HostConfig.PortBindings.PSObject.Properties).Count -gt 0){throw 'Cleanup refused: isolated container ownership mismatch.'}
 Docker @('rm','--force',$Name)|Out-Null
}
function Restore-Databases($Base,$Name,$PgImage,$DataVolume=''){
 Assert-MountPath $Base
 $temporaryVolume=$false
 if(-not $DataVolume){
  $DataVolume='factuez-verify-'+$run
  if(Docker @('volume','ls','--quiet','--filter',('name=^'+$DataVolume+'$'))){throw 'Restore validation volume already exists.'}
  $null=Docker @('volume','create','--label',"$label=$run",$DataVolume)
  $v=Read-Volume $DataVolume;if($v.Labels.$label -ne $run){throw 'Restore validation volume ownership mismatch.'}
  $temporaryVolume=$true
 }
 $argsList=@('run','--detach','--pull','never','--name',$Name,'--label',"$label=$run",'--network','none','--memory','640m','--memory-swap','640m','--cpus','1','--pids-limit','160','--mount',"type=bind,source=$Base,target=/backup,readonly",'--env','POSTGRES_PASSWORD_FILE=/backup/state/secrets/postgres_admin_password')
 $argsList+=@('--mount',"type=volume,source=$DataVolume,target=/var/lib/postgresql/data")
 $created=$false
 try {
  Docker ($argsList+@($PgImage,'postgres','-c','fsync=on','-c','synchronous_commit=on','-c','full_page_writes=on'))|Out-Null;$created=$true
  $ready=$false
  for($i=0;$i -lt 90;$i++){
   try{$null=Docker @('exec',$Name,'pg_isready','-h','127.0.0.1','-U','postgres');$ready=$true;break}catch{Start-Sleep -Milliseconds 300}
  }
  if(-not $ready){throw 'ISOLATED_RESTORE_POSTGRES_NOT_READY'}
  # Fixed shell program: no input-derived interpolation. psql quotes both identifiers and values.
  $roleScript=@'
set -eu
for component in identity billing sunat mailer received; do
 owner="factuez_${component}"
 OWNER_PASSWORD="$(cat "/backup/state/secrets/${component}_db_password")"
 case "$OWNER_PASSWORD" in ''|*[!0-9a-f]*) exit 61;; esac
 export OWNER_PASSWORD
 psql -X -q --set=ON_ERROR_STOP=1 -U postgres -d postgres --set=owner="$owner" <<'SQL'
\getenv owner_password OWNER_PASSWORD
CREATE ROLE :"owner" LOGIN PASSWORD :'owner_password';
SELECT format('CREATE DATABASE %I OWNER %I', :'owner', :'owner')\gexec
SQL
 unset OWNER_PASSWORD
done
'@
  Docker @('exec',$Name,'sh','-ec',$roleScript.Replace("`r`n","`n"))|Out-Null
  foreach($db in $databases){
   $owner='factuez_'+$db
   Phase ('RESTORE_'+$owner)
   Docker @('exec',$Name,'pg_restore','--exit-on-error','--single-transaction','--username','postgres','--dbname',$owner,('/backup/databases/'+$owner+'.dump'))|Out-Null
   $identity=Docker @('exec',$Name,'psql','-X','-qAt','--set=ON_ERROR_STOP=1','-U',$owner,'-d',$owner,'-c',"SELECT current_database() || ':' || current_user || ':' || pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")
   if($identity.Trim() -cne ($owner+':'+$owner+':'+$owner)){throw 'RESTORE_DATABASE_OWNER_MISMATCH'}
   Docker @('exec',$Name,'pg_dump','--username','postgres','--dbname',$owner,'--format=custom','--file',('/tmp/'+$owner+'.dump'))|Out-Null
  }
  return 'ALL_FIVE_DATABASES_RESTORED'
 }finally{
  if($created){Remove-OwnedContainer $Name}
  if($temporaryVolume){$v=Read-Volume $DataVolume;if($v.Labels.$label -ne $run){throw 'Validation cleanup refused: volume ownership mismatch.'};Docker @('volume','rm',$DataVolume)|Out-Null}
 }
}
function Snapshot-Release {
 $paths=@('infra/deployment/windows-test','infra/deployment/core-production/kong.yml','docker/Dockerfile.service','docker/Dockerfile.web-pwa','scripts/update-igv-catalogs-gre.cjs','scripts/export-production-schemas.cjs','scripts/export-windows-test-schemas.cjs')
 $files=@(foreach($p in $paths){Get-ChildItem -LiteralPath (Join-Path $root $p) -File -Recurse|ForEach-Object {@{path=$_.FullName.Substring($root.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}})
 foreach($service in @('billing-service','sunat-service')){foreach($p in Get-ChildItem -LiteralPath (Join-Path $root ('services/'+$service+'/prisma')) -Filter '*.sql' -File -Recurse){$files+=@{path=$p.FullName.Substring($root.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $p.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}}
 $commit=& git -C $root rev-parse HEAD 2>$null
 if($LASTEXITCODE -ne 0){$commit='UNKNOWN'}
 $changes=@(& git -C $root status --porcelain --untracked-files=normal 2>$null)
 @{version=1;commit="$commit";sourceTree=$(if($changes.Count){'DIRTY'}else{'CLEAN'});files=$files}
}
function Assert-BuiltRelease {
 if($SyntheticScope){return}
 $file=Join-Path $state 'build-release.json'
 if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Complete Build required before Update; no recorded release manifest.'}
 $release=Read-Json $file
 if($release.version -ne 1){throw 'Unsupported build release manifest.'}
 $current=Snapshot-Release
 if($current.sourceTree -ne 'CLEAN' -or $current.commit -cne $release.commit){throw 'Source revision changed after Build. Complete a clean Build before Update.'}
 foreach($s in @('identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa')){
  $expected=$release.images.$s
  $actual=Docker @('image','inspect','--format','{{.Id}}',('factuez-windows-test/'+$s+':local'))
  if($expected -notmatch '^sha256:[a-f0-9]{64}$' -or $actual.Trim() -cne $expected){throw ('Incomplete/mixed Build image set: '+$s+'. Run Build successfully before Update.')}
 }
 foreach($f in @($release.files)){
  $p=[IO.Path]::GetFullPath((Join-Path $root $f.path))
  if(-not $p.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath $p -PathType Leaf)){throw 'Build source file missing or outside release root.'}
  if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Deployment/migration source changed after Build. Complete Build again before Update.'}
 }
}
function Build-Evidence {
 $release=Snapshot-Release
 if($release.sourceTree -ne 'CLEAN' -or $release.commit -notmatch '^[a-f0-9]{40}$'){throw 'Commit the complete reviewed source before Build/Prepare.'}
 $images=@{}
 foreach($s in @('identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa')){
  $metadata=@((Docker @('image','inspect',('factuez-windows-test/'+$s+':local')))|ConvertFrom-Json)[0]
  if(-not $metadata.Config.Labels -or $metadata.Config.Labels.'org.opencontainers.image.revision' -cne $release.commit){throw ('Image revision does not match this checkout: '+$s+'. Complete Build before Prepare/Update.')}
  $images[$s]=$metadata.Id
 }
 $release['images']=$images
 return $release
}
function Backup([switch]$LeaveStopped) {
 Assert-Installation
 if($ExternalDestination -and -not $ExternalDestinationReviewed){throw 'Review the external destination and supply -ExternalDestinationReviewed; backup contains fiscal data and private keys.'}
 if($ExternalDestination){Assert-MountPath $ExternalDestination;if(-not(Test-Path -LiteralPath $ExternalDestination -PathType Container)){throw 'Reviewed external destination must already exist.'};$external=[IO.Path]::GetFullPath($ExternalDestination);if($external.StartsWith($state,[StringComparison]::OrdinalIgnoreCase)){throw 'External destination cannot be inside installation state.'}}
 $all=@(Containers);$pg=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -eq 'postgres'})
 if($pg.Count -ne 1 -or -not $pg[0].State.Running){throw 'One running installed PostgreSQL container required.'}
 $pg=$pg[0];$pgImage=Image $pg
 $running=@($all|Where-Object {$_.State.Running -and $_.Id -ne $pg.Id}|ForEach-Object {$_.Config.Labels.'com.docker.compose.service'})
 $base=Join-Path $state ('backups/'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$run.Substring(0,8)+'.incomplete')
 New-Item -ItemType Directory -Path $base|Out-Null;Protect-Directory $base
 $script:logPath=Join-Path $base 'operations.log'
 Write-Json (Join-Path $base 'operation.json') @{version=1;phase='STARTED';project=$ProjectName;startedUtc=[DateTime]::UtcNow.ToString('o')}
 $stopped=$false
 $backupSucceeded=$false
 try {
  # All services including receivers, mailers and Redis stop; PostgreSQL remains for logical dumps.
  if($running.Count){$stopped=$true;Compose (@('stop','--timeout','90')+$running)|Out-Null}
  Phase 'WRITERS_QUIESCED'
  $active=Docker @('exec',$pg.Id,'psql','-X','-qAt','--set=ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c',"SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")
  if($active.Trim() -ne '0'){throw 'DATABASE_WRITERS_STILL_CONNECTED: close external tools and retry.'}
  New-Item -ItemType Directory -Path (Join-Path $base 'databases'),(Join-Path $base 'volumes'),(Join-Path $base 'state'),(Join-Path $base 'release')|Out-Null
  Phase 'POSTGRES_CONFIGURATION'
  $configTemp='/tmp/factuez-'+$run+'-postgres-config.tar'
  $rolesTemp='/tmp/factuez-'+$run+'-roles.sql'
  try {
   Docker @('exec',$pg.Id,'tar','-C','/var/lib/postgresql/data','-cf',$configTemp,'postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf')|Out-Null
   Docker @('cp',($pg.Id+':'+$configTemp),(Join-Path $base 'release/postgres-configuration.tar'))|Out-Null
   Docker @('exec',$pg.Id,'pg_dumpall','--username','postgres','--roles-only','--no-role-passwords','--file',$rolesTemp)|Out-Null
   Docker @('cp',($pg.Id+':'+$rolesTemp),(Join-Path $base 'release/postgres-roles-without-passwords.sql'))|Out-Null
  }finally{Docker @('exec',$pg.Id,'rm','-f',$configTemp,$rolesTemp)|Out-Null}
  foreach($db in $databases){$owner='factuez_'+$db;Phase ('DUMP_'+$owner);$temp='/tmp/factuez-'+$run+'-'+$owner+'.dump';try{
   Docker @('exec',$pg.Id,'pg_dump','--username','postgres','--dbname',$owner,'--format=custom','--file',$temp)|Out-Null
   Docker @('exec',$pg.Id,'pg_restore','--list',$temp)|Out-Null
   Docker @('cp',($pg.Id+':'+$temp),(Join-Path $base ('databases/'+$owner+'.dump')))|Out-Null
  }finally{Docker @('exec',$pg.Id,'rm','-f',$temp)|Out-Null}}
  foreach($name in @('secrets','gre','pki','schemas','public.env','network.override.json','prepared.marker','build-release.json','previous-images.json')){$p=Join-Path $state $name;if(Test-Path -LiteralPath $p){Copy-Item -LiteralPath $p -Destination (Join-Path $base 'state') -Recurse}}
  foreach($v in $persistent){
   Phase ('ARCHIVE_'+$v)
   $source=Volume $v;Assert-MountPath $base
   Docker @('run','--rm','--pull','never','--label',"$label=$run",'--network','none','--memory','128m','--cpus','0.5','--mount',"type=volume,source=$source,target=/source,readonly",'--mount',"type=bind,source=$base,target=/backup",'--entrypoint','tar',$pgImage,'-C','/source','-cf',('/backup/volumes/'+$v+'.tar'),'.')|Out-Null
  }
  Copy-Item -LiteralPath $compose -Destination (Join-Path $base 'release/docker-compose.json')
  Phase 'POSTGRES_IMAGE'
  Docker @('image','save','--output',(Join-Path $base 'release/postgres-image.tar'),$pgImage)|Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'infra/deployment/core-production/kong.yml') -Destination (Join-Path $base 'release/kong.yml')
  Write-Json (Join-Path $base 'release/source.json') (Snapshot-Release)
  $images=@($all|ForEach-Object {@{service=$_.Config.Labels.'com.docker.compose.service';imageId=(Image $_);configuredImage=$_.Config.Image}})
  $validated=Restore-Databases $base ('factuez-verify-'+$run) $pgImage
  Write-Json (Join-Path $base 'operation.json') @{version=1;phase='VALIDATED';project=$ProjectName;finishedUtc=[DateTime]::UtcNow.ToString('o')}
  $manifest=@{version=1;status='COMPLETE';project=$ProjectName;createdUtc=[DateTime]::UtcNow.ToString('o');restoreValidation=$validated;postgresImageId=$pgImage;images=$images;databases=@($databases|ForEach-Object {'factuez_'+$_});persistentVolumes=$persistent;files=@(MetadataFiles $base);externalProtection='LOCAL_ONLY_UNTIL_SEPARATE_COPY_VERIFIED'}
  Write-Json (Join-Path $base 'manifest.json') $manifest
  $hash=(Get-FileHash -LiteralPath (Join-Path $base 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $base 'manifest.sha256'),$hash+"`n",$utf8)
  [IO.File]::WriteAllText((Join-Path $base 'COMPLETE'),$hash+"`n",$utf8)
  $null=Verify $base -Staging
  $complete=$base -replace '\.incomplete$','';Move-Item -LiteralPath $base -Destination $complete;$base=$complete;$script:logPath=Join-Path $base 'operations.log'
  if($ExternalDestination){
   $dest=Join-Path $external ([IO.Path]::GetFileName($base)+'.incomplete')
   if(Test-Path -LiteralPath $dest){throw 'External backup target already exists.'}
   New-Item -ItemType Directory -Path $dest|Out-Null;Protect-Directory $dest
   # COMPLETE is copied last, after independent verification of every payload byte.
   Get-ChildItem -LiteralPath $base -Force|Where-Object {$_.Name -ne 'COMPLETE'}|Copy-Item -Destination $dest -Recurse
   $null=Verify $dest -Staging
   Copy-Item -LiteralPath (Join-Path $base 'COMPLETE') -Destination $dest
   $externalComplete=$dest -replace '\.incomplete$','';Move-Item -LiteralPath $dest -Destination $externalComplete
   Write-Host ('EXTERNAL_COPY_VERIFIED: '+$externalComplete+'; operator must confirm separate disk/offsite and retention.')
  }else{Write-Host 'DISK_LOSS_PROTECTION_NOT_ESTABLISHED: local backup only; copy to a reviewed separate disk/offsite destination.'}
  Write-Host ('BACKUP_VERIFIED: '+$base)
  $backupSucceeded=$true
  return $base
 }catch{
  if(Test-Path -LiteralPath $base){
   $marker=Join-Path $base 'COMPLETE';if(Test-Path -LiteralPath $marker){Remove-Item -LiteralPath $marker -Force}
   if($base -notmatch '\.incomplete$'){
    $failed=$base+'.incomplete'
    $backupRoot=[IO.Path]::GetFullPath((Join-Path $state 'backups'))+[IO.Path]::DirectorySeparatorChar
    if(-not([IO.Path]::GetFullPath($failed).StartsWith($backupRoot,[StringComparison]::OrdinalIgnoreCase))){throw 'Backup failure path outside installation backup root.'}
    Move-Item -LiteralPath $base -Destination $failed;$base=$failed;$script:logPath=Join-Path $base 'operations.log'
   }
   Write-Json (Join-Path $base 'FAILED.json') @{status='FAILED';atUtc=[DateTime]::UtcNow.ToString('o');reason='Backup or external copy failed. Preserve this directory and operations.log; correct the reported operation and retry.'}
  }
  throw
 }finally{
  if($stopped -and $running.Count -and (-not $LeaveStopped -or -not $backupSucceeded)){Compose (@('start')+$running)|Out-Null}
 }
}
function Restore {
 $manifest=Verify $BackupPath
 if($RecoveryProject -notmatch '^factuez-recovery-[a-z0-9][a-z0-9-]{5,50}$'){throw 'Use a separately named factuez-recovery-<unique> project.'}
 if(-not $RecoveryPath){throw 'New isolated -RecoveryPath required.'}
 $target=[IO.Path]::GetFullPath($RecoveryPath)
 if((Test-Path -LiteralPath $target) -or $target.StartsWith($state,[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery target must be new and outside live installation state.'}
 if(Docker @('ps','--all','--quiet','--filter',"label=com.docker.compose.project=$RecoveryProject")){throw 'Recovery project already exists.'}
 if(Docker @('volume','ls','--quiet','--filter',"label=com.docker.compose.project=$RecoveryProject")){throw 'Recovery project volumes already exist.'}
 try{$null=Docker @('image','inspect',$manifest.postgresImageId)}catch{
  $archive=Join-Path ([IO.Path]::GetFullPath($BackupPath)) 'release/postgres-image.tar'
  if(-not(Test-Path -LiteralPath $archive -PathType Leaf)){throw 'Restore requires the exact PostgreSQL image or its verified archive.'}
  Docker @('image','load','--input',$archive)|Out-Null
  $loaded=Docker @('image','inspect','--format','{{.Id}}',$manifest.postgresImageId)
  if($loaded.Trim() -cne $manifest.postgresImageId){throw 'Restored PostgreSQL image identity mismatch.'}
 }
 New-Item -ItemType Directory -Path $target|Out-Null;Protect-Directory $target
 $script:logPath=Join-Path $target 'operations.log'
 Copy-Item -LiteralPath (Join-Path $BackupPath 'state') -Destination (Join-Path $target 'state') -Recurse
 Copy-Item -LiteralPath (Join-Path $BackupPath 'release') -Destination (Join-Path $target 'release') -Recurse
 # Retain the original configuration privately, with no running application or transmission path.
 [IO.File]::WriteAllText((Join-Path $target 'RECOVERY_NOT_ACTIVATED'),"ISOLATED_DATA_ONLY. Review release, keys, PKI and per-RUC readiness before any controlled customer cutover.`n",$utf8)
 $volumes=@{}
 try {
  foreach($v in @('pgdata')+$persistent){$name=$RecoveryProject+'_'+$v;if(Docker @('volume','ls','--quiet','--filter',('name=^'+$name+'$'))){throw 'Recovery volume name collision.'};$null=Docker @('volume','create','--label',"$label=$run",'--label',"com.docker.compose.project=$RecoveryProject",'--label',"com.docker.compose.volume=$v",$name);$created=Read-Volume $name;if($created.Labels.$label -ne $run){throw 'Recovery volume was concurrently created by another operation; refusing access.'};$volumes[$v]=$name}
  $null=Restore-Databases ([IO.Path]::GetFullPath($BackupPath)) ($RecoveryProject+'-postgres-validation') $manifest.postgresImageId $volumes.pgdata
  foreach($v in $persistent){
   Docker @('run','--rm','--pull','never','--label',"$label=$run",'--network','none','--memory','128m','--cpus','0.5','--mount',('type=volume,source='+$volumes[$v]+',target=/target'),'--mount',("type=bind,source="+[IO.Path]::GetFullPath($BackupPath)+",target=/backup,readonly"),'--entrypoint','tar',$manifest.postgresImageId,'-C','/target','-xf',('/backup/volumes/'+$v+'.tar'))|Out-Null
  }
  Write-Json (Join-Path $target 'recovery.json') @{version=1;status='ISOLATED_RESTORE_VERIFIED';project=$RecoveryProject;scope=$run;sourceManifestSha256=[IO.File]::ReadAllText((Join-Path $BackupPath 'manifest.sha256')).Trim();volumes=$volumes;postgresImageId=$manifest.postgresImageId;transmission='NOT_STARTED';activation='CUSTOMER_CUTOVER_REQUIRES_REVIEW'}
  Write-Json (Join-Path $target 'recovery-compose.json') @{name=$RecoveryProject;services=@{postgres=@{image=$manifest.postgresImageId;network_mode='none';restart='no';mem_limit='640m';memswap_limit='640m';cpus=1;pids_limit=160;labels=@{$label=$run};command=@('postgres','-c','fsync=on','-c','synchronous_commit=on','-c','full_page_writes=on');volumes=@(@{type='volume';source='recovered_pgdata';target='/var/lib/postgresql/data'})}};volumes=@{recovered_pgdata=@{external=$true;name=$volumes.pgdata}}}
  Write-Host ('ISOLATED_RESTORE_VERIFIED: '+$target+'; containers removed, recovered volumes retained, no ports or transmission.')
 }catch{Write-Json (Join-Path $target 'FAILED.json') @{status='RESTORE_FAILED';project=$RecoveryProject;scope=$run;reason='Keep operations.log and the uniquely labeled recovery volumes for review; live installation untouched.'};throw}
}
function Status {
 if(-not(Test-Path -LiteralPath (Join-Path $state 'prepared.marker'))){@{version=1;project=$ProjectName;installation='NOT_FOUND';machine='UNKNOWN';fiscalAcceptance='NOT_ESTABLISHED';fuelRegulatedGre='NOT_ESTABLISHED';perRuc=@{availability='NOT_AUTHENTICATED';state='UNKNOWN'};action='Locate the customer installation; never Prepare/reset to repair it.'}|ConvertTo-Json -Depth 5;return}
 Assert-Installation
 $storage=@{state='UNKNOWN';minimumFreeBytes=5GB;dockerDisk='UNKNOWN'}
 try {
  $stateDrive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($state))
  $storage['installationFreeBytes']=$stateDrive.AvailableFreeSpace
  $disk=$DockerDiskPath
  if(-not $disk){$disk=Join-Path $env:LOCALAPPDATA 'Docker/wsl/disk/docker_data.vhdx'}
  if(Test-Path -LiteralPath $disk -PathType Leaf){
   $hostDrive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($disk)))
   $storage.dockerDisk=[IO.Path]::GetFullPath($disk)
   $storage['dockerHostFreeBytes']=$hostDrive.AvailableFreeSpace
   $storage.state=if($hostDrive.AvailableFreeSpace -ge 5GB -and $stateDrive.AvailableFreeSpace -ge 5GB){'AVAILABLE'}else{'LOW'}
  }
 }catch{$storage.state='UNKNOWN'}
 $report=[ordered]@{version=1;project=$ProjectName;checkedAtUtc=[DateTime]::UtcNow.ToString('o');machine='UNKNOWN';fiscalAcceptance='NOT_ESTABLISHED';fuelRegulatedGre='UNSUPPORTED';perRuc=@{availability='NOT_AUTHENTICATED';state='UNKNOWN'};services=@();durability=@{};pki=@();gre=@();bootstrap='UNKNOWN';authenticationKeys='UNKNOWN';webAccess='UNKNOWN';serverActivation='UNKNOWN';release=@{installed='UNKNOWN'}}
 try {
  $all=@(Containers)
  $report.services=@($all|ForEach-Object {
   $flags=@{};foreach($item in @($_.Config.Env)){if($item -match '^((?:BILLING_PRODUCTION_ISSUANCE|SUNAT_PRODUCTION_WORKFLOW|NATIVE_GRE|NATIVE_GRE_WORKERS)_ENABLED)=(true|false)$'){$flags[$matches[1]]=$matches[2]}}
   $health='UNKNOWN';if($_.State.PSObject.Properties.Name -contains 'Health'){$health=$_.State.Health.Status}
   $revision='UNKNOWN';if($_.Config.Labels.PSObject.Properties.Name -contains 'org.opencontainers.image.revision'){$revision=$_.Config.Labels.'org.opencontainers.image.revision'}
   @{service=$_.Config.Labels.'com.docker.compose.service';status=$_.State.Status;health=$health;imageId=$_.Image;configuredImage=$_.Config.Image;revision=$revision;flags=$flags;mounts=@($_.Mounts|ForEach-Object {@{type=$_.Type;destination=$_.Destination;source=$_.Source;writable=$_.RW}})}
  })
  $pg=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -eq 'postgres' -and $_.State.Running})
  if($pg.Count -eq 1){$values=Docker @('exec',$pg[0].Id,'psql','-X','-qAt','--set=ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c',"SELECT name || '=' || setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','data_checksums','wal_level') ORDER BY name");foreach($v in ($values -split "`n")){$pair=$v.Split('=',2);if($pair.Count -eq 2){$report.durability[$pair[0]]=$pair[1]}}}else{throw 'POSTGRES_UNREACHABLE_OR_STOPPED'}
  $identity=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -eq 'identity-service'})
  if($identity.Count -eq 1){$boot=@($identity[0].Config.Env|Where-Object {$_ -match '^INITIAL_ADMIN_USERNAME=.+$'});$report.bootstrap=if($boot.Count){'ENABLED'}else{'DISABLED'}}
  if($identity.Count -eq 1 -and $identity[0].State.Running){
   try{$probe="try{const f=require('fs'),c=require('crypto'),p=f.readFileSync(process.env.JWT_PRIVATE_KEY_FILE),q=f.readFileSync(process.env.JWT_PUBLIC_KEY_FILE),b=Buffer.from('read-only-readiness');try{if(!c.verify('sha256',b,q,c.sign('sha256',b,p)))throw Error()}finally{p.fill(0);q.fill(0)}}catch{process.exitCode=1}"
    $null=Docker @('exec','--user','1000:1000',$identity[0].Id,'node','-e',$probe);$report.authenticationKeys='VERIFIED_NONROOT_PAIR'
   }catch{$report.authenticationKeys='BLOCKED'}
  }
  $kong=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -eq 'kong' -and $_.State.Running})
  if($kong.Count -eq 1){
   try {
    $binding=@($kong[0].HostConfig.PortBindings.'8000/tcp'|Where-Object {$_.HostIp -eq '127.0.0.1' -and $_.HostPort -eq '8091'})
    if($binding.Count -ne 1){throw 'UNEXPECTED_LOCAL_PORT'}
    $http=Local-Get '/login'
    if($http.statusCode -eq 200){$report.webAccess='VERIFIED_LOCAL_LOGIN'}else{$report.webAccess='BLOCKED'}
   }catch{$report.webAccess='UNREACHABLE_OR_UNEXPECTED_PORT'}
  }
  $billing=@($report.services|Where-Object {$_.service -eq 'billing-service'});$sunat=@($report.services|Where-Object {$_.service -eq 'sunat-service'})
  if($billing.Count -eq 1 -and $sunat.Count -eq 1){
   $b=$billing[0].flags['BILLING_PRODUCTION_ISSUANCE_ENABLED'];$s=$sunat[0].flags['SUNAT_PRODUCTION_WORKFLOW_ENABLED']
   if($b -eq 'true' -and $s -eq 'true' -and $billing[0].health -eq 'healthy' -and $sunat[0].health -eq 'healthy'){$report.serverActivation='ENABLED_SERVER_ONLY'}elseif($b -eq 'false' -and $s -eq 'false'){$report.serverActivation='DISABLED'}else{$report.serverActivation='PARTIAL_OR_UNAVAILABLE'}
  }
  $required=@('postgres','redis','identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','received-sync-worker','web-pwa','kong')
  $ok=@($required|Where-Object {$name=$_;@($report.services|Where-Object {$_.service -eq $name -and $_.status -eq 'running' -and $_.health -eq 'healthy'}).Count -ne 1}).Count -eq 0
  $durable=$report.durability.fsync -eq 'on' -and $report.durability.synchronous_commit -eq 'on' -and $report.durability.full_page_writes -eq 'on'
  $report['persistence']='OWNERSHIP_VERIFIED'
  try{
   $bindings=@{pgdata=@('postgres','/var/lib/postgresql/data');redis_data=@('redis','/data');billing_service_print_branding=@('billing-service','/data/print-branding');sunat_service_artifacts=@('sunat-service','/data/artifacts');sunat_service_private=@('sunat-service','/data/private');web_pwa_cache=@('web-pwa','/workspace/apps/web-pwa/.next/cache')}
   foreach($v in @('pgdata')+$persistent){
    $owned=Volume $v;$binding=$bindings[$v]
    $service=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -eq $binding[0]})
    if($service.Count -ne 1){throw 'PERSISTENCE_SERVICE_MISSING'}
    $mount=@($service[0].Mounts|Where-Object {$_.Type -eq 'volume' -and $_.Name -eq $owned -and $_.Destination -eq $binding[1] -and $_.RW})
    if($mount.Count -ne 1){throw 'PERSISTENCE_MOUNT_MISMATCH'}
   }
  }catch{$report.persistence='MISSING_OR_UNVERIFIED'}
  if($ok -and $durable -and $report.bootstrap -eq 'DISABLED' -and $report.persistence -eq 'OWNERSHIP_VERIFIED' -and $report.authenticationKeys -eq 'VERIFIED_NONROOT_PAIR' -and $report.webAccess -eq 'VERIFIED_LOCAL_LOGIN' -and $storage.state -eq 'AVAILABLE'){$report.machine='READY'}else{$report.machine='BLOCKED'}
 }catch{$report.machine='UNKNOWN';$report['transport']='UNREACHABLE_OR_INCOMPLETE';$report['failureType']=$_.Exception.GetType().Name;$report['failure']='Inspect Docker Desktop and installation services; no activation inferred.'}
 foreach($f in @('issuer-roots.pem','crls.pem','cdr-signers.pem')){$p=Join-Path $state ('pki/'+$f);$entry=@{file=$f;present=(Test-Path -LiteralPath $p -PathType Leaf);trust='NOT_VALIDATED_BY_DIAGNOSTICS'};if($entry.present){$entry['sha256']=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant();$entry['bytes']=(Get-Item -LiteralPath $p).Length};$report.pki+=@($entry)}
 $gre=Join-Path $state 'gre'
 $requiredGre=@('manifest.json','transport-ca-private.pem')
 foreach($side in @('identity','billing','sunat')){foreach($f in @('ca.pem','transport-cert.pem','transport-key.pem','config.json')){$requiredGre+=($side+'/'+$f)};if($side -ne 'identity'){foreach($f in @('signing-private.pem','billing-public.pem','sunat-public.pem')){$requiredGre+=($side+'/'+$f)}}};$requiredGre+='sunat/catalogues.json'
 $report.gre=@(foreach($f in $requiredGre){$p=Join-Path $gre $f;$entry=@{file=$f;present=(Test-Path -LiteralPath $p -PathType Leaf)};if($entry.present){$entry['bytes']=(Get-Item -LiteralPath $p).Length;$entry['sha256']=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()};$entry})
 $built=Join-Path $state 'build-release.json';if(Test-Path -LiteralPath $built){$b=Read-Json $built;$report.release=@{builtCommit=$b.commit;builtManifestSha256=(Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant();installed='SEE_RUNTIME_IMAGE_IDS'}}
 if($ReadinessSessionFile){
  try {
   $session=Read-Json $ReadinessSessionFile
   if($session.companyId -notmatch '^[a-zA-Z0-9-]{1,80}$' -or $session.accessToken -notmatch '^[a-zA-Z0-9_.-]+$'){throw 'INVALID_SESSION'}
   # Fixed local origin prevents credential exfiltration; redirects are disabled.
   $uri='/api/v1/setup/sunat/'+$session.companyId+'/PRODUCTION/readiness'
   $response=Local-Get $uri ('Bearer '+$session.accessToken)
   $r=$response.body|ConvertFrom-Json
   $allowed=@('PASS','BLOCKED','PENDING','NOT_APPLICABLE')
   $checks=@($r.checks|ForEach-Object {if($_.code -match '^[A-Z0-9_]{1,80}$' -and $_.status -in $allowed){@{code=$_.code;status=$_.status}}})
   if($checks.Count -eq 0 -or $checks.Count -ne @($r.checks).Count -or $r.environment -ne 'PRODUCTION'){throw 'INCOMPLETE_READINESS_RESPONSE'}
   $stateResult=if($r.state -eq 'READY' -and $r.readyForProduction -eq $true -and $checks.Count -gt 0 -and @($checks|Where-Object {$_.status -notin @('PASS','NOT_APPLICABLE')}).Count -eq 0){'READY'}else{'BLOCKED'}
   $report.perRuc=@{availability='AUTHENTICATED';state=$stateResult;checks=$checks;officialAcceptance='NOT_ESTABLISHED'}
  }catch{$report.perRuc=@{availability='UNREACHABLE_OR_UNAUTHORIZED';state='UNKNOWN'}}finally{$session=$null}
 }
 $report.fuelRegulatedGre='CHECK_RUC_CAPABILITIES'
 $report['storage']=$storage
 $report|ConvertTo-Json -Depth 12
}
if($Action -eq 'VerifyBackup'){$null=Verify $BackupPath;Write-Host 'OFFLINE_BACKUP_HASHES_VERIFIED';return}
if($Action -eq 'CheckImages'){$null=Build-Evidence;Write-Host 'SOURCE_AND_IMAGE_REVISIONS_VERIFIED';return}
if($Action -eq 'Status'){Status;return}
if($Action -eq 'RestoreBackup'){Restore;return}
Assert-Installation
$lockPath=Join-Path $state 'operations.lock';$lock=$null
try {
 try{$lock=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)}catch{throw 'Another operation or interrupted operation owns operations.lock. Review process state/logs before manually removing a stale lock.'}
 if($Action -ne 'RecordRelease' -and (Test-Path -LiteralPath (Join-Path $state 'build.lock'))){throw 'Build in progress or interrupted. Review build.lock before updating or backing up.'}
 if($Action -eq 'RecordRelease'){
  $release=Build-Evidence;Write-Json (Join-Path $state 'build-release.json') $release;return
 }
 if($Action -eq 'Update'){Assert-BuiltRelease}
 $verified=Backup -LeaveStopped:($Action -eq 'Update')
 if($Action -eq 'Update'){
  try {
  Write-Json (Join-Path $state 'last-update.json') @{version=1;status='MIGRATING';backup=$verified;startedUtc=[DateTime]::UtcNow.ToString('o')}
  # Writers stay quiesced from backup through migrations; failed migration leaves them stopped.
  foreach($service in @('billing-service','sunat-service')){Phase ('MIGRATE_'+$service);Compose @('run','--rm','--no-deps','--entrypoint','node',$service,'scripts/update-igv-catalogs-gre.cjs',$service,'--apply')|Out-Null}
  Compose @('up','--detach','--no-build','--wait','--wait-timeout','300')|Out-Null
  Write-Json (Join-Path $state 'last-update.json') @{version=1;status='APPLIED';backup=$verified;finishedUtc=[DateTime]::UtcNow.ToString('o');fiscalAcceptance='NOT_ESTABLISHED'}
  Write-Host ('UPDATE_APPLIED: '+$verified+'; inspect Status and authenticated per-RUC readiness before operation.')
  }catch{Write-Json (Join-Path $state 'last-update.json') @{version=1;status='FAILED';backup=$verified;failedUtc=[DateTime]::UtcNow.ToString('o');action='Review backup operations.log and migration/service state before restarting writers.'};throw}
 }
}finally{if($lock){$lock.Dispose();Remove-Item -LiteralPath $lockPath -Force}}
