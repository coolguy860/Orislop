param([switch]$SkipOllamaWarmup)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeRoot = Join-Path $RepoRoot ".cache\runtime"
$DetectorPython = Join-Path $RepoRoot ".venv-detector\Scripts\python.exe"
$DetectorServer = Join-Path $RepoRoot "apps\detector-bridge\server.py"
$DetectorHealth = "http://127.0.0.1:4317/health"
$OllamaHealth = "http://127.0.0.1:11434/api/tags"
$OllamaGenerate = "http://127.0.0.1:11434/api/generate"
$OllamaModel = if ($env:ORISLOP_OLLAMA_MODEL) { $env:ORISLOP_OLLAMA_MODEL } else { "qwen2.5:1.5b-instruct" }
$OllamaKeepAlive = if ($env:ORISLOP_OLLAMA_KEEP_ALIVE) { $env:ORISLOP_OLLAMA_KEEP_ALIVE } else { "24h" }
$Ollama = Get-Command ollama -ErrorAction Stop
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

function Test-JsonEndpoint([string]$Uri) {
  try {
    Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 2 | Out-Null
    return $true
  } catch { return $false }
}

function Wait-ForEndpoint([string]$Uri, [System.Diagnostics.Process]$Process, [int]$TimeoutSeconds) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $Deadline) {
    if (Test-JsonEndpoint $Uri) { return }
    if ($Process -and $Process.HasExited) { throw "Orislop service exited before becoming ready." }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for $Uri"
}

if (-not (Test-JsonEndpoint $OllamaHealth)) {
  $OllamaProcess = Start-Process -FilePath $Ollama.Source -ArgumentList @("serve") -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot "ollama.out.log") -RedirectStandardError (Join-Path $RuntimeRoot "ollama.err.log") -PassThru
  [IO.File]::WriteAllText((Join-Path $RuntimeRoot "ollama.pid"), [string]$OllamaProcess.Id)
  Wait-ForEndpoint $OllamaHealth $OllamaProcess 45
  Write-Host "Ollama started (PID $($OllamaProcess.Id))."
} else { Write-Host "Ollama is already running." }

& $Ollama.Source show $OllamaModel *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Downloading required Ollama model $OllamaModel..."
  & $Ollama.Source pull $OllamaModel
  if ($LASTEXITCODE -ne 0) { throw "Ollama could not pull $OllamaModel." }
}

if (-not $SkipOllamaWarmup) {
  Write-Host "Warming required Qwen model..."
  $WarmBody = @{ model = $OllamaModel; prompt = "Reply only with OK."; stream = $false; keep_alive = $OllamaKeepAlive; options = @{ num_predict = 4; temperature = 0 } } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Uri $OllamaGenerate -Method Post -ContentType "application/json" -Body $WarmBody -TimeoutSec 120 | Out-Null
}

if (-not (Test-Path -LiteralPath $DetectorPython)) { throw "Detector environment is missing. Run pnpm detector:setup first." }
if (-not (Test-JsonEndpoint $DetectorHealth)) {
  $DetectorProcess = Start-Process -FilePath $DetectorPython -ArgumentList @($DetectorServer) -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot "detector.out.log") -RedirectStandardError (Join-Path $RuntimeRoot "detector.err.log") -PassThru
  [IO.File]::WriteAllText((Join-Path $RuntimeRoot "detector.pid"), [string]$DetectorProcess.Id)
  Wait-ForEndpoint $DetectorHealth $DetectorProcess 120
  Write-Host "Orislop detector started (PID $($DetectorProcess.Id))."
} else { Write-Host "Orislop detector is already running." }

$Health = Invoke-RestMethod -Uri $DetectorHealth -Method Get -TimeoutSec 5
Write-Host "Orislop is ready: $($Health.state), Fast workers: $($Health.lightweight_workers), accelerator: $($Health.accelerator)."
Write-Host "Browser windows were not started or closed."
