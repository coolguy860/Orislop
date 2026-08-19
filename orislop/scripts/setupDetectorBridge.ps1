$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Venv = Join-Path $RepoRoot ".venv-detector"

$Python = Get-Command py -ErrorAction SilentlyContinue
if ($Python) {
  & $Python.Source -3 -m venv $Venv
} else {
  $Python = Get-Command python -ErrorAction Stop
  & $Python.Source -m venv $Venv
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $RepoRoot "apps\detector-bridge\requirements.txt")

Write-Host "Orislop detector bridge is installed."
Write-Host "Run: pnpm detector:start"
