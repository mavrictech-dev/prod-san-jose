#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/diagnose-gre-series.ps1')
$script:commands = New-Object System.Collections.Generic.List[object]
$requestId = 'b1fa2754-55bc-4391-8f86-bb9dbdfeef85'
$mock = {
 param($Arguments, $InputText)
 $script:commands.Add([pscustomobject]@{ arguments = @($Arguments); inputText = $InputText })
 if ($Arguments -contains 'ps') { return [pscustomobject]@{ exitCode = 0; stdout = "abcdef123456`n"; stderr = '' } }
 if ($Arguments -contains 'logs') {
  $row = [ordered]@{ requestId = $requestId; status = 500; code = 'INTERNAL_ERROR'; method = 'POST'; route = '/api/v1/production-guides/series'; exception = 'PrismaClientKnownRequestError'; sqlState = '23505'; constraint = 'SeriesCounter_companyId_documentType_series_key'; sql = 'SYNTHETIC_DO_NOT_EMIT'; authorization = 'SYNTHETIC_DO_NOT_EMIT' } | ConvertTo-Json -Compress
  return [pscustomobject]@{ exitCode = 0; stdout = "unrelated SYNTHETIC_DO_NOT_EMIT`n$row`n"; stderr = '{"requestId":"00000000-0000-4000-8000-000000000000","exception":"SYNTHETIC_DO_NOT_EMIT"}' }
 }
 if (-not $InputText.StartsWith('BEGIN READ ONLY;') -or -not $InputText.Contains("SET LOCAL statement_timeout='5s';") -or -not $InputText.Contains("schemaname='public'") -or -not $InputText.Contains('FROM public."SeriesCounter"')) { throw 'SELFTEST_READ_ONLY_SQL_REQUIRED' }
 $metadata = @{ billingCanInsertCounter = $true; businessUniqueConstraintPresent = $true; secret = 'SYNTHETIC_DO_NOT_EMIT'; companies = @(@{ companyId = 1; active = $true; salesEnvironment = 'BETA'; secret = 'SYNTHETIC_DO_NOT_EMIT'; counters = @(@{ pointId = '00000000-0000-4000-8000-000000000003'; environment = 'PRODUCTION'; active = $true; alreadyUsed = $false; secret = 'SYNTHETIC_DO_NOT_EMIT' }) }) } | ConvertTo-Json -Depth 8 -Compress
 return [pscustomobject]@{ exitCode = 0; stdout = "$metadata`n"; stderr = 'SYNTHETIC_DO_NOT_EMIT' }
}
$result = Invoke-GreSeriesDiagnostic -RunDocker $mock
$json = $result | ConvertTo-Json -Depth 12 -Compress
if ($json.Contains('SYNTHETIC_DO_NOT_EMIT') -or $result.matchingLogRecords -ne 1 -or $result.requestMetadata[0].sqlState -cne '23505' -or $result.currentSeriesMetadata.companies[0].counters[0].pointId -cne '00000000-0000-4000-8000-000000000003') { throw 'SELFTEST_PROJECTION_FAILED' }
if ($script:commands.Count -ne 4 -or @($script:commands | Where-Object { $_.arguments -contains 'inspect' -or $_.arguments -contains 'config' }).Count -ne 0) { throw 'SELFTEST_COMMAND_SCOPE_FAILED' }
$failed = $false
try { Invoke-GreSeriesDiagnostic -RunDocker { param($Arguments,$InputText) [pscustomobject]@{ exitCode = 1; stdout = 'SYNTHETIC_DO_NOT_EMIT'; stderr = 'SYNTHETIC_DO_NOT_EMIT' } } | Out-Null } catch { $failed = $_.Exception.Message -ceq 'READ_ONLY_CONTAINER_LOOKUP_FAILED' }
if (-not $failed) { throw 'SELFTEST_SANITIZED_FAILURE_REQUIRED' }
[pscustomobject]@{ synthetic = $true; installationCommandsExecuted = 0; requestIdProjection = 'passed'; databaseColumnProjection = 'passed'; readOnlySql = 'passed'; sanitizedFailures = 'passed'; powershellVersion = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
