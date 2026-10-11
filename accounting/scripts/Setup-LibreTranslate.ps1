$ErrorActionPreference = 'Stop'
$runtimeRoot = if ($env:EXIOS_TRANSLATION_RUNTIME_DIR) { $env:EXIOS_TRANSLATION_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'ExiosTranslation' }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$uvDirectory = Join-Path $runtimeRoot 'uv'
$uvExecutable = Get-ChildItem -LiteralPath $uvDirectory -Filter uv.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $uvExecutable) {
  $archive = Join-Path $runtimeRoot 'uv.zip'
  Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $uvDirectory -Force
  $uvExecutable = Get-ChildItem -LiteralPath $uvDirectory -Filter uv.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
}
$env:UV_SYSTEM_CERTS = 'true'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
$env:UV_CACHE_DIR = Join-Path $runtimeRoot 'cache'
$python = Join-Path $runtimeRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  & $uvExecutable venv --python 3.12 (Join-Path $runtimeRoot 'venv')
  if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
}
& $uvExecutable pip install --python $python 'libretranslate==1.9.6' 'chardet<6'
if ($LASTEXITCODE -ne 0) { throw 'Translation engine installation failed.' }
Write-Output 'Installed. Run Start-LibreTranslate.ps1 -Background. First launch downloads selected language models.'
