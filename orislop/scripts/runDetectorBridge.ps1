$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $RepoRoot ".venv-detector\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
  throw "Detector environment is missing. Run pnpm detector:setup first."
}
& $Python (Join-Path $RepoRoot "apps\detector-bridge\server.py")
