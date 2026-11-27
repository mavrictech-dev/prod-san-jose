#requires -Version 5.1
[CmdletBinding()]
param()

# Operator-invoked, read-only, fixed incident scope. Never prints raw Docker output.
function Invoke-GreSeriesDocker {
 param([string[]]$Arguments, [string]$InputText = '')
 $ErrorActionPreference = 'Stop'
 foreach ($item in $Arguments) {
  if ($item -cnotmatch '^[A-Za-z0-9_./:{}=,-]+$') { throw 'READ_ONLY_ARGUMENT_REJECTED' }
 }
 $dockerPath = (Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source
 $info = New-Object System.Diagnostics.ProcessStartInfo
 $info.FileName = $dockerPath
 $info.Arguments = (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
 $info.UseShellExecute = $false
 $info.CreateNoWindow = $true
 $info.RedirectStandardInput = $true
 $info.RedirectStandardOutput = $true
 $info.RedirectStandardError = $true
 $process = New-Object System.Diagnostics.Process
 $process.StartInfo = $info
 try {
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($InputText)
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'READ_ONLY_COMMAND_TIMEOUT' }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout.Length -gt 16777216 -or $stderr.Length -gt 16777216) { throw 'READ_ONLY_OUTPUT_LIMIT' }
  return [pscustomobject]@{ exitCode = $process.ExitCode; stdout = $stdout; stderr = $stderr }
 } catch {
  throw 'READ_ONLY_DOCKER_COMMAND_FAILED'
 } finally {
  $process.Dispose()
 }
}

function Get-GreSeriesProperty {
 param($Value, [string]$Name)
 if ($null -eq $Value) { return $null }
 $property = $Value.PSObject.Properties[$Name]
 if ($null -ne $property) { return $property.Value }
 return $null
}

function Invoke-GreSeriesDiagnostic {
 # The injected runner is for the isolated selftest; normal invocation uses Docker.
 param([scriptblock]$RunDocker = { param($Arguments, $InputText) Invoke-GreSeriesDocker -Arguments $Arguments -InputText $InputText })
 $ErrorActionPreference = 'Stop'
 $requestId = 'b1fa2754-55bc-4391-8f86-bb9dbdfeef85'
 $classes = @('PrismaClientKnownRequestError','PrismaClientUnknownRequestError','PrismaClientValidationError','BadRequestException','ConflictException','ForbiddenException','ServiceUnavailableException','Error')
 $codes = @('INTERNAL_ERROR','INVALID_REQUEST','STATE_CONFLICT','ACCESS_DENIED','SERVICE_UNAVAILABLE','GRE_SERIES_ALREADY_EXISTS','GRE_SERIES_INVALID_REQUEST','GRE_SERIES_INVALID_POINT')
 $sqlStates = @('23505','23503','23502','23514','42501','42P01','42703','40001','40P01')
 $constraints = @('SeriesCounter_companyId_documentType_series_key','SeriesCounter_pkey','SeriesCounter_emissionPointId_companyId_fkey','SeriesCounter_companyId_fkey')
 $containers = @{}
 foreach ($service in @('billing-service','postgres')) {
  $answer = & $RunDocker @('--context','desktop-linux','ps','--filter','label=com.docker.compose.project=factuez-san-jose-test','--filter',('label=com.docker.compose.service=' + $service),'--format','{{.ID}}') ''
  if ($answer.exitCode -ne 0) { throw 'READ_ONLY_CONTAINER_LOOKUP_FAILED' }
  $ids = @($answer.stdout -split '\r?\n' | Where-Object { $_.Trim().Length -gt 0 })
  if ($ids.Count -ne 1 -or $ids[0] -cnotmatch '^[a-f0-9]{12,64}$') { throw 'EXACT_INSTALLATION_CONTAINER_REQUIRED' }
  $containers[$service] = $ids[0]
 }
 $logs = & $RunDocker @('--context','desktop-linux','logs','--since','72h','--tail','10000',$containers['billing-service']) ''
 if ($logs.exitCode -ne 0) { throw 'READ_ONLY_LOG_METADATA_UNAVAILABLE' }
 $records = New-Object System.Collections.Generic.List[object]
 foreach ($line in (($logs.stdout + "`n" + $logs.stderr) -split '\r?\n')) {
  if (-not $line.Contains($requestId)) { continue }
  $clean = $line -replace '\x1b\[[0-9;]*m',''
  $start = $clean.IndexOf('{"requestId"')
  $end = $clean.LastIndexOf('}')
  if ($start -lt 0 -or $end -lt $start) { continue }
  try { $row = $clean.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { continue }
  if ((Get-GreSeriesProperty $row 'requestId') -cne $requestId) { continue }
  $status = Get-GreSeriesProperty $row 'status'
  $code = Get-GreSeriesProperty $row 'code'
  $exception = Get-GreSeriesProperty $row 'exception'
  $safe = [ordered]@{ kind = 'request-metadata'; requestId = $requestId }
  if (($status -is [int] -or $status -is [long]) -and $status -ge 100 -and $status -le 599) { $safe.status = $status }
  $safe.code = 'OTHER'; if ($codes -ccontains $code) { $safe.code = $code }
  $safe.exception = 'OTHER'; if ($classes -ccontains $exception) { $safe.exception = $exception }
  if ((Get-GreSeriesProperty $row 'method') -ceq 'POST') { $safe.method = 'POST' }
  if ((Get-GreSeriesProperty $row 'route') -ceq '/api/v1/production-guides/series') { $safe.route = '/api/v1/production-guides/series' }
  foreach ($key in @('sqlState','databaseCode')) {
   $value = Get-GreSeriesProperty $row $key
   if ($sqlStates -ccontains $value) { $safe[$key] = $value }
  }
  $constraint = Get-GreSeriesProperty $row 'constraint'
  if ($constraints -ccontains $constraint) { $safe.constraint = $constraint }
  $records.Add([pscustomobject]$safe)
 }
 $sql = @'
BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT json_build_object(
 'issuerRuc','20600979630','series','T099','historicalCauseConfirmed',false,
 'billingCanInsertCounter',has_table_privilege('factuez_billing','public."SeriesCounter"','INSERT'),
 'businessUniqueConstraintPresent',EXISTS(SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename='SeriesCounter' AND indexname='SeriesCounter_companyId_documentType_series_key'),
 'companies',COALESCE((SELECT json_agg(json_build_object(
  'companyId',c.id,'active',c.active,'salesEnvironment',c.environment,
  'counters',(SELECT COALESCE(json_agg(json_build_object('pointId',s."emissionPointId",'environment',s.environment,'active',s.active,'alreadyUsed',s."nextNumber">1)), '[]'::json)
    FROM public."SeriesCounter" s WHERE s."companyId"=c.id AND s."documentType"='DESPATCH_ADVICE' AND s.series='T099')))
 FROM public."CompanySettings" c WHERE c.ruc='20600979630'),'[]'::json));
COMMIT;
'@
 $database = & $RunDocker @('--context','desktop-linux','exec','-i',$containers['postgres'],'psql','-X','-q','-t','-A','-U','postgres','-d','factuez_billing','-v','ON_ERROR_STOP=1') $sql
 if ($database.exitCode -ne 0) { throw 'READ_ONLY_DATABASE_METADATA_UNAVAILABLE' }
 $jsonRows = @($database.stdout -split '\r?\n' | Where-Object { $_.Trim().StartsWith('{') })
 if ($jsonRows.Count -ne 1) { throw 'READ_ONLY_DATABASE_METADATA_INVALID' }
 try { $metadata = $jsonRows[0] | ConvertFrom-Json } catch { throw 'READ_ONLY_DATABASE_METADATA_INVALID' }
 # Project every DB column explicitly; even unexpected DB output cannot escape.
 $companies = New-Object System.Collections.Generic.List[object]
 foreach ($company in @(Get-GreSeriesProperty $metadata 'companies')) {
  if ($null -eq $company) { continue }
  $companyId = Get-GreSeriesProperty $company 'companyId'
  $active = Get-GreSeriesProperty $company 'active'
  $environment = Get-GreSeriesProperty $company 'salesEnvironment'
  if (($companyId -isnot [int] -and $companyId -isnot [long]) -or $active -isnot [bool] -or @('BETA','PRODUCTION') -cnotcontains $environment) { throw 'READ_ONLY_DATABASE_METADATA_INVALID' }
  $counters = New-Object System.Collections.Generic.List[object]
  foreach ($counter in @(Get-GreSeriesProperty $company 'counters')) {
   if ($null -eq $counter) { continue }
   $pointId = Get-GreSeriesProperty $counter 'pointId'
   $counterEnvironment = Get-GreSeriesProperty $counter 'environment'
   $counterActive = Get-GreSeriesProperty $counter 'active'
   $alreadyUsed = Get-GreSeriesProperty $counter 'alreadyUsed'
   if ($pointId -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or @('BETA','PRODUCTION') -cnotcontains $counterEnvironment -or $counterActive -isnot [bool] -or $alreadyUsed -isnot [bool]) { throw 'READ_ONLY_DATABASE_METADATA_INVALID' }
   $counters.Add([pscustomobject]@{ pointId = $pointId; environment = $counterEnvironment; active = $counterActive; alreadyUsed = $alreadyUsed })
  }
  $companies.Add([pscustomobject]@{ companyId = $companyId; active = $active; salesEnvironment = $environment; counters = @($counters.ToArray()) })
 }
 $canInsert = Get-GreSeriesProperty $metadata 'billingCanInsertCounter'
 $uniquePresent = Get-GreSeriesProperty $metadata 'businessUniqueConstraintPresent'
 if ($canInsert -isnot [bool] -or $uniquePresent -isnot [bool]) { throw 'READ_ONLY_DATABASE_METADATA_INVALID' }
 return [pscustomobject]@{
  requestId = $requestId; matchingLogRecords = $records.Count; requestMetadata = @($records.ToArray())
  currentSeriesMetadata = [pscustomobject]@{ issuerRuc = '20600979630'; series = 'T099'; historicalCauseConfirmed = $false; billingCanInsertCounter = $canInsert; businessUniqueConstraintPresent = $uniquePresent; companies = @($companies.ToArray()) }
 }
}

if ($MyInvocation.InvocationName -ne '.') {
 try {
  if ($args.Count -ne 0) { throw 'NO_ARGUMENTS_ACCEPTED' }
  Invoke-GreSeriesDiagnostic | ConvertTo-Json -Depth 12 -Compress
 } catch {
  # Constant error only: never emit exception messages or native stdout/stderr.
  [Console]::Error.WriteLine('GRE_SERIES_READ_ONLY_DIAGNOSTIC_FAILED')
  exit 1
 }
}
