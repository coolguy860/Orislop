[CmdletBinding()]
param(
  [switch]$Live,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvironmentPath = Join-Path $RepoRoot "apps\detector-bridge\.env.local"
$Checks = [Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $Checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail })
}

function Read-EnvironmentFile([string]$Path) {
  $Values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $Values }
  foreach ($Raw in Get-Content -LiteralPath $Path) {
    $Line = $Raw.Trim()
    if (-not $Line -or $Line.StartsWith("#") -or -not $Line.Contains("=")) { continue }
    $Name, $Value = $Line.Split("=", 2)
    $Values[$Name.Trim()] = $Value.Trim().Trim('"').Trim("'")
  }
  return $Values
}

function Get-Setting([hashtable]$Values, [string]$Name) {
  if ($Values.ContainsKey($Name)) { return [string]$Values[$Name] }
  return [string][Environment]::GetEnvironmentVariable($Name)
}

$Environment = Read-EnvironmentFile $EnvironmentPath
Add-Check "local environment" (Test-Path -LiteralPath $EnvironmentPath) $EnvironmentPath

foreach ($Relative in @(
  "configs\model_adapters.json",
  "configs\cloud_heavy_v1.json",
  "configs\model_provenance.json"
)) {
  $Target = Join-Path $RepoRoot $Relative
  try {
    Get-Content -LiteralPath $Target -Raw | ConvertFrom-Json | Out-Null
    Add-Check $Relative $true "valid JSON"
  } catch {
    Add-Check $Relative $false $_.Exception.Message
  }
}

$PackagePath = Get-Setting $Environment "ORISLOP_TEMPORAL_PACKAGE_PATH"
$RepoId = Get-Setting $Environment "ORISLOP_TEMPORAL_HF_REPO_ID"
$Revision = Get-Setting $Environment "ORISLOP_TEMPORAL_HF_REVISION"
$ExpectedSha = (Get-Setting $Environment "ORISLOP_TEMPORAL_MODEL_SHA256").ToLowerInvariant()
$TemporalEnabled = Get-Setting $Environment "ORISLOP_TEMPORAL_ENABLED"
Add-Check "promoted temporal enabled" ($TemporalEnabled -eq "1") "ORISLOP_TEMPORAL_ENABLED=$TemporalEnabled"

if ($PackagePath) {
  try {
    $ResolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
    $Required = @("config.json", "metrics.json")
    $Weights = @("final_model.safetensors", "final_model.pt") |
      ForEach-Object { Join-Path $ResolvedPackage $_ } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    $RequiredPresent = -not ($Required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ResolvedPackage $_) -PathType Leaf) })
    Add-Check "local temporal package" ([bool]($RequiredPresent -and $Weights)) $ResolvedPackage
    if ($Weights) {
      $ActualSha = (Get-FileHash -LiteralPath $Weights -Algorithm SHA256).Hash.ToLowerInvariant()
      $ManifestPath = Join-Path $ResolvedPackage "artifact_manifest.json"
      if (Test-Path -LiteralPath $ManifestPath) {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        $ManifestPassed = $true
        foreach ($Property in $Manifest.files.PSObject.Properties) {
          $Candidate = [IO.Path]::GetFullPath((Join-Path $ResolvedPackage $Property.Name))
          if (-not $Candidate.StartsWith($ResolvedPackage + [IO.Path]::DirectorySeparatorChar)) { $ManifestPassed = $false; break }
          if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { $ManifestPassed = $false; break }
          $Digest = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($Digest -ne ([string]$Property.Value).ToLowerInvariant()) { $ManifestPassed = $false; break }
        }
        Add-Check "temporal artifact manifest" $ManifestPassed $ManifestPath
      } else {
        Add-Check "temporal weights hash" ($ExpectedSha -and $ActualSha -eq $ExpectedSha) "actual=$ActualSha"
      }
    }
  } catch {
    Add-Check "local temporal package" $false $_.Exception.Message
  }
} elseif ($RepoId) {
  Add-Check "temporal model repo" ($RepoId -match "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$") $RepoId
  Add-Check "immutable model revision" ($Revision -match "^[0-9a-fA-F]{40,64}$") $Revision
  Add-Check "pinned model hash" ($ExpectedSha -match "^[0-9a-f]{64}$") $ExpectedSha
} else {
  Add-Check "promoted temporal source" $false "no local package or Hugging Face model repo configured"
}

$OllamaModel = Get-Setting $Environment "ORISLOP_OLLAMA_MODEL"
if (-not $OllamaModel) { $OllamaModel = "qwen2.5:1.5b-instruct" }
Add-Check "Ollama executable" ([bool](Get-Command ollama -ErrorAction SilentlyContinue)) $OllamaModel

if ($Live) {
  try {
    $Tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
    $Names = @($Tags.models | ForEach-Object { if ($_.model) { $_.model } else { $_.name } })
    Add-Check "Ollama live model" ($Names -contains $OllamaModel) ($Names -join ", ")
  } catch {
    Add-Check "Ollama live model" $false $_.Exception.Message
  }
  try {
    $Health = Invoke-RestMethod -Uri "http://127.0.0.1:4317/health" -TimeoutSec 10
    $TemporalState = [string]$Health.model_states.temporal
    Add-Check "detector bridge" ([bool]$Health.ok) ([string]$Health.state)
    Add-Check "promoted temporal loaded" ($TemporalState -eq "ready") $TemporalState
    Add-Check "temporal integrity reported" ([bool]$Health.models.cloud_heavy.promoted_temporal_integrity_verified) ([string]$Health.models.cloud_heavy.promoted_temporal_rollout)
  } catch {
    Add-Check "detector bridge" $false $_.Exception.Message
  }
}

$Passed = -not ($Checks | Where-Object { -not $_.passed })
$Report = [ordered]@{
  product = "Orislop Shield"
  version = "1.1.0"
  live = [bool]$Live
  passed = [bool]$Passed
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  checks = $Checks
}

if ($Json) {
  $Report | ConvertTo-Json -Depth 8
} else {
  foreach ($Check in $Checks) {
    $Label = if ($Check.passed) { "PASS" } else { "FAIL" }
    $Color = if ($Check.passed) { "Green" } else { "Red" }
    Write-Host ("[{0}] {1}: {2}" -f $Label, $Check.name, $Check.detail) -ForegroundColor $Color
  }
  Write-Host $(if ($Passed) { "Orislop launch preflight passed." } else { "Orislop launch preflight failed." }) -ForegroundColor $(if ($Passed) { "Green" } else { "Red" })
}

if (-not $Passed) { exit 1 }
