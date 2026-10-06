param([string]$TrialDate = '20261006')
$ErrorActionPreference = 'Stop'
if ($TrialDate -notmatch '^\d{8}$') { throw 'Invalid local trial date.' }
$trialDatabase = "exios-september-trial-$TrialDate"
$trialStatePath = Join-Path $env:USERPROFILE "Downloads\Exios-September-Trial-$TrialDate\verified-trial.json"
if (-not (Test-Path -LiteralPath $trialStatePath)) { throw 'The September trial has not passed verification yet.' }
$trialState = Get-Content -LiteralPath $trialStatePath -Raw | ConvertFrom-Json
if ($trialState.database -ne $trialDatabase -or $trialState.status -ne 'committed') { throw 'Unexpected trial state.' }
$backendDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$listeners = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($listeners) { throw 'Stop the existing backend on port 8000, then run this script again.' }
$previousTrialMongoUrl = $env:MONGO_URL_2
$previousTrialBackupBucket = $env:BACKUP_BUCKET
$previousLocalTrialFlag = $env:EXIOS_LOCAL_ACCOUNTING_TRIAL
Push-Location -LiteralPath $backendDirectory
try {
    $env:MONGO_URL_2 = "mongodb://127.0.0.1:27017/${trialDatabase}?directConnection=true"
    $env:EXIOS_LOCAL_ACCOUNTING_TRIAL = '1'
    $env:BACKUP_BUCKET = ''
    Write-Host "September trial: bank movements start on $($trialState.operationalStart); opening book balances are for $($trialState.countDay)."
    npm run app
} finally {
    $env:MONGO_URL_2 = $previousTrialMongoUrl
    $env:BACKUP_BUCKET = $previousTrialBackupBucket
    $env:EXIOS_LOCAL_ACCOUNTING_TRIAL = $previousLocalTrialFlag
    Pop-Location
}
