[CmdletBinding()]
param(
  [string]$TemporalPackagePath = $env:ORISLOP_TEMPORAL_PACKAGE_PATH,
  [string]$TemporalHfRepoId = $env:ORISLOP_TEMPORAL_HF_REPO_ID,
  [string]$TemporalHfRevision = $env:ORISLOP_TEMPORAL_HF_REVISION,
  [string]$TemporalModelSha256 = $env:ORISLOP_TEMPORAL_MODEL_SHA256,
  [ValidateSet("shadow", "corroborated")]
  [string]$TemporalRollout = "shadow",
  [string]$OllamaModel = "qwen2.5:1.5b-instruct",
  [switch]$SkipInstall,
  [switch]$SkipTests,
  [switch]$Start
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BridgeRoot = Join-Path $RepoRoot "apps\detector-bridge"
$LocalEnvironment = Join-Path $BridgeRoot ".env.local"
$VenvPython = Join-Path $RepoRoot ".venv-detector\Scripts\python.exe"

function Resolve-PythonCommand {
  $Py = Get-Command py -ErrorAction SilentlyContinue
  if ($Py) { return @($Py.Source, "-3") }
  $Python = Get-Command python -ErrorAction Stop
  return @($Python.Source)
}

function Invoke-Python {
  param([string[]]$PythonCommand, [string[]]$Arguments)
  $Executable = $PythonCommand[0]
  $Prefix = @($PythonCommand | Select-Object -Skip 1)
  & $Executable @Prefix @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Python command failed with exit code $LASTEXITCODE" }
}

function Set-EnvironmentValue {
  param([string]$Path, [string]$Name, [string]$Value)
  $Lines = if (Test-Path -LiteralPath $Path) { [Collections.Generic.List[string]](Get-Content -LiteralPath $Path) } else { [Collections.Generic.List[string]]::new() }
  $Replacement = "$Name=$Value"
  $Found = $false
  for ($Index = 0; $Index -lt $Lines.Count; $Index += 1) {
    if ($Lines[$Index] -match "^\s*$([regex]::Escape($Name))=") {
      $Lines[$Index] = $Replacement
      $Found = $true
    }
  }
  if (-not $Found) { $Lines.Add($Replacement) }
  [IO.File]::WriteAllLines($Path, $Lines, [Text.UTF8Encoding]::new($false))
}

Write-Host "[bootstrap] Orislop Shield launch preparation" -ForegroundColor Yellow
Write-Host "[bootstrap] repo=$RepoRoot"

$Node = Get-Command node -ErrorAction Stop
$NodeVersion = (& $Node.Source --version).Trim().TrimStart("v")
$NodeMajor = [int]($NodeVersion.Split(".")[0])
if ($NodeMajor -lt 22 -or $NodeMajor -ge 25) {
  throw "Node $NodeVersion is unsupported. Install Node 22.12 through 24.x."
}

$Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$PnpmVersion = if ($Pnpm) { (& $Pnpm.Source --version).Trim() } else { "" }
if (-not $Pnpm -or $PnpmVersion -ne "11.9.0") {
  $env:COREPACK_HOME = Join-Path $RepoRoot ".cache\corepack"
  $Corepack = Get-Command corepack -ErrorAction Stop
  & $Corepack.Source pnpm@11.9.0 --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Corepack could not acquire pnpm 11.9.0." }
  $Pnpm = $Corepack
  $PnpmPrefix = @("pnpm@11.9.0")
} else {
  $PnpmPrefix = @()
}

$PythonCommand = Resolve-PythonCommand
Invoke-Python $PythonCommand @("-c", "import sys; assert sys.version_info >= (3, 11), sys.version")

if (-not $TemporalPackagePath) {
  foreach ($Candidate in @(
    (Join-Path $RepoRoot "models\temporal\final_model_package"),
    (Join-Path $RepoRoot "final_model_package")
  )) {
    if (Test-Path -LiteralPath $Candidate -PathType Container) {
      $TemporalPackagePath = (Resolve-Path -LiteralPath $Candidate).Path
      break
    }
  }
}

if ($TemporalPackagePath -and $TemporalHfRepoId) {
  throw "Choose one promoted-model source: TemporalPackagePath or TemporalHfRepoId, not both."
}
if (-not $TemporalPackagePath -and -not $TemporalHfRepoId) {
  throw @"
The promoted temporal package is not available yet. Supply either:
  -TemporalPackagePath 'C:\path\to\final_model_package'
or a private Hugging Face model source:
  -TemporalHfRepoId 'owner/repo' -TemporalHfRevision '<40-char commit>' -TemporalModelSha256 '<64-char sha256>'
The Google Drive training path is not directly readable by a hosted runtime.
"@
}

if ($TemporalPackagePath) {
  $TemporalPackagePath = (Resolve-Path -LiteralPath $TemporalPackagePath).Path
  Invoke-Python $PythonCommand @(
    (Join-Path $RepoRoot "scripts\build_temporal_artifact_manifest.py"),
    $TemporalPackagePath
  )
  $TemporalHfRepoId = ""
  $TemporalHfRevision = ""
  $TemporalModelSha256 = ""
} else {
  if ($TemporalHfRepoId -notmatch "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$") {
    throw "TemporalHfRepoId must be an owner/repository model ID."
  }
  if ($TemporalHfRevision -notmatch "^[0-9a-fA-F]{40,64}$") {
    throw "TemporalHfRevision must be an immutable 40-64 character hexadecimal commit."
  }
  if ($TemporalModelSha256 -notmatch "^[0-9a-fA-F]{64}$") {
    throw "TemporalModelSha256 must be the 64-character SHA-256 of final_model.safetensors or final_model.pt."
  }
}

New-Item -ItemType Directory -Path $BridgeRoot -Force | Out-Null
Set-EnvironmentValue $LocalEnvironment "ORISLOP_OLLAMA_URL" "http://127.0.0.1:11434"
Set-EnvironmentValue $LocalEnvironment "ORISLOP_OLLAMA_MODEL" $OllamaModel
Set-EnvironmentValue $LocalEnvironment "ORISLOP_OLLAMA_KEEP_ALIVE" "24h"
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TRUSTED_OLLAMA_HOST" ""
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_ENABLED" "1"
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_PACKAGE_PATH" $TemporalPackagePath
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_HF_REPO_ID" $TemporalHfRepoId
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_HF_REVISION" $TemporalHfRevision
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_HF_SUBDIR" "final_model_package"
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_MODEL_SHA256" $TemporalModelSha256
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_LEGACY_FALLBACK" "0"
Set-EnvironmentValue $LocalEnvironment "ORISLOP_TEMPORAL_ROLLOUT" $TemporalRollout
Set-EnvironmentValue $LocalEnvironment "ORISLOP_PRELOAD_HEAVY_MODE" "1"

if (-not $SkipInstall) {
  Push-Location $RepoRoot
  try {
    & $Pnpm.Source @PnpmPrefix install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
    if (-not (Test-Path -LiteralPath $VenvPython)) {
      & $Pnpm.Source @PnpmPrefix detector:setup
      if ($LASTEXITCODE -ne 0) { throw "Detector environment setup failed." }
    } else {
      & $VenvPython -c "import torch, transformers, huggingface_hub, cv2, safetensors"
      if ($LASTEXITCODE -ne 0) {
        & $VenvPython -m pip install -r (Join-Path $BridgeRoot "requirements.txt")
        if ($LASTEXITCODE -ne 0) { throw "Detector dependency repair failed." }
      }
    }
  } finally {
    Pop-Location
  }
}

$Ollama = Get-Command ollama -ErrorAction Stop
& $Ollama.Source show $OllamaModel *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[bootstrap] downloading Ollama model $OllamaModel"
  & $Ollama.Source pull $OllamaModel
  if ($LASTEXITCODE -ne 0) { throw "Ollama could not pull $OllamaModel." }
}

if (-not $SkipTests) {
  Push-Location $RepoRoot
  try {
    & $Pnpm.Source @PnpmPrefix temporal:package:test
    if ($LASTEXITCODE -ne 0) { throw "Temporal package contract tests failed." }
    & $Pnpm.Source @PnpmPrefix extension:test
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
    & $Pnpm.Source @PnpmPrefix extension:build
    if ($LASTEXITCODE -ne 0) { throw "Extension build failed." }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "orislopLaunchCheck.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Orislop launch preflight failed." }
  } finally {
    Pop-Location
  }
}

Write-Host "[bootstrap] COMPLETE - configuration, model integrity, Ollama, and extension are prepared." -ForegroundColor Green
if ($Start) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "launchOrislop.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Orislop launch failed." }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "orislopLaunchCheck.ps1") -Live
  if ($LASTEXITCODE -ne 0) { throw "Orislop launched, but the live readiness check failed." }
} else {
  Write-Host "[bootstrap] Start it with: pnpm orislop:start"
}
