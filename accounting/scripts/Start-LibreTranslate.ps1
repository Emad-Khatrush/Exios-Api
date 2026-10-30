param([switch]$Background, [int]$Port = 5005)
$ErrorActionPreference = 'Stop'
$runtimeRoot = if ($env:EXIOS_TRANSLATION_RUNTIME_DIR) { $env:EXIOS_TRANSLATION_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'ExiosTranslation' }
$executable = Join-Path $runtimeRoot 'venv\Scripts\libretranslate.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Run Setup-LibreTranslate.ps1 first.' }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
$env:XDG_DATA_HOME = Join-Path $runtimeRoot 'data'
$env:XDG_CACHE_HOME = Join-Path $runtimeRoot 'model-cache'
$env:ARGOS_CHUNK_TYPE = 'MINISBD'
$env:ARGOS_INTER_THREADS = '1'
$env:ARGOS_INTRA_THREADS = '2'
$arguments = @('--host', '127.0.0.1', '--port', "$Port", '--load-only', 'en,ar,zh,tr', '--threads', '2', '--disable-web-ui', '--disable-files-translation')
if ($Background) {
  try {
    $languages = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/languages" -TimeoutSec 2
    if ($languages) { Write-Output "Translation engine is already running on port $Port."; return }
  } catch { }
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtimeRoot 'service.log') -RedirectStandardError (Join-Path $runtimeRoot 'service-error.log')
  Write-Output "Translation process: $($process.Id). Logs: $runtimeRoot"
} else { & $executable @arguments }
