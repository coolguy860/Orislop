param(
  [switch]$IncludeOllama
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeRoot = Join-Path $RepoRoot ".cache\runtime"

function Stop-RecordedProcess {
  param([string]$Name)
  $PidFile = Join-Path $RuntimeRoot "$Name.pid"
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  $RecordedPid = [int](Get-Content -LiteralPath $PidFile -Raw)
  $Process = Get-Process -Id $RecordedPid -ErrorAction SilentlyContinue
  if ($Process) {
    Stop-Process -Id $RecordedPid
    Write-Host "Stopped $Name (PID $RecordedPid)."
  }
  Remove-Item -LiteralPath $PidFile -Force
}

Stop-RecordedProcess "detector"
if ($IncludeOllama) { Stop-RecordedProcess "ollama" }
Write-Host "Orislop companion services stopped. Browser windows were not touched."
