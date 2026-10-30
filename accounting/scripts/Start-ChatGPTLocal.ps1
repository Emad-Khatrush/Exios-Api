param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$env:NODE_USE_SYSTEM_CA = '1'
$runtimeDir = Join-Path $env:LOCALAPPDATA 'ExiosChatGPT'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$scriptPath = Join-Path $PSScriptRoot 'chatgpt-local.js'
$nodePath = (Get-Command node.exe).Source
$port = if ($env:EXIOS_CHATGPT_PORT) { $env:EXIOS_CHATGPT_PORT } else { '5010' }
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Start-Process -FilePath $nodePath -ArgumentList @(('"' + $scriptPath + '"')) -WorkingDirectory (Split-Path $scriptPath) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'service.log') -RedirectStandardError (Join-Path $runtimeDir 'service-error.log') | Out-Null
}
Write-Host "Local assistant: http://127.0.0.1:$port/"
if ($OpenBrowser) { Start-Process "http://127.0.0.1:$port/" }
