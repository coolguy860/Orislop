param(
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Model = if ($env:ORISLOP_OLLAMA_MODEL) { $env:ORISLOP_OLLAMA_MODEL } else { "qwen2.5:1.5b-instruct" }

function Test-Endpoint {
  param([string]$Uri)
  try {
    return Invoke-RestMethod -Uri $Uri -TimeoutSec 5
  } catch {
    return $null
  }
}

$Ollama = Test-Endpoint "http://127.0.0.1:11434/api/tags"
$Detector = Test-Endpoint "http://127.0.0.1:4317/health"
$FactChecker = if ($Detector) { $Detector.fact_checker } else { $null }
$Security = if ($Detector) { $Detector.security } else { $null }
$VisualRollout = if ($Detector) { $Detector.visual_rollout } else { $null }
$TemporalState = if ($Detector -and $Detector.model_states) { [string]$Detector.model_states.temporal } else { "unavailable" }
$TemporalConfig = if ($Detector -and $Detector.models -and $Detector.models.cloud_heavy) { $Detector.models.cloud_heavy } else { $null }
$OriginLocked = [bool]($Security -and $Security.extension_origin_policy -eq "allowlist")
$OriginlessDisabled = [bool]($Security -and -not $Security.originless_posts)
$VenvPython = Join-Path $RepoRoot ".venv-detector\Scripts\python.exe"
$ModelInstalled = $false
if ($Ollama -and $Ollama.models) {
  $ModelInstalled = [bool]($Ollama.models | Where-Object { $_.name -eq $Model -or $_.model -eq $Model })
}

$Gpu = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$GpuName = "CPU"
if ($Gpu) {
  try {
    $GpuName = (& $Gpu.Source --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1).Trim()
  } catch {
    $GpuName = "NVIDIA GPU detected"
  }
}

$Report = [ordered]@{
  product = "Orislop Shield"
  version = "1.1.0"
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  ready = [bool]($Ollama -and $ModelInstalled -and $Detector -and $Detector.ok -and $Detector.dependencies -eq "available" -and $TemporalState -eq "ready" -and $FactChecker -and $FactChecker.configured -and $OriginLocked -and $OriginlessDisabled)
  ollama = [ordered]@{
    reachable = [bool]$Ollama
    requiredModel = $Model
    modelInstalled = $ModelInstalled
  }
  detector = [ordered]@{
    reachable = [bool]$Detector
    state = if ($Detector) { $Detector.state } else { "offline" }
    version = if ($Detector) { $Detector.version } else { $null }
    dependencies = if ($Detector) { $Detector.dependencies } else { "unknown" }
    accelerator = if ($Detector) { $Detector.accelerator } else { $GpuName }
    modelStates = if ($Detector) { $Detector.model_states } else { $null }
    queueDepth = if ($Detector) { $Detector.queue_depth } else { 0 }
    visualRolloutMode = if ($VisualRollout) { $VisualRollout.mode } else { "unavailable" }
    automaticFiltering = [bool]($VisualRollout -and $VisualRollout.automatic_skip_enabled)
  }
  temporal = [ordered]@{
    state = $TemporalState
    rollout = if ($TemporalConfig) { $TemporalConfig.promoted_temporal_rollout } else { "disabled" }
    integrityVerified = [bool]($TemporalConfig -and $TemporalConfig.promoted_temporal_integrity_verified)
  }
  factChecker = [ordered]@{
    configured = [bool]($FactChecker -and $FactChecker.configured)
    state = if ($FactChecker) { $FactChecker.state } else { "unavailable" }
    providers = if ($FactChecker) { $FactChecker.providers } else { $null }
    queueDepth = if ($FactChecker) { $FactChecker.queue_depth } else { 0 }
  }
  security = [ordered]@{
    network = if ($Security) { $Security.network } else { "unavailable" }
    extensionOriginLocked = $OriginLocked
    originlessPostsDisabled = $OriginlessDisabled
  }
  installation = [ordered]@{
    detectorEnvironment = Test-Path -LiteralPath $VenvPython
    repo = $RepoRoot.Path
  }
}

if ($Json) {
  $Report | ConvertTo-Json -Depth 8
} else {
  Write-Host ""
  Write-Host "  ORISLOP SHIELD 1.1" -ForegroundColor Yellow
  Write-Host "  Production readiness check" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host ("  Ollama       {0}" -f $(if ($Ollama) { "online" } else { "offline" })) -ForegroundColor $(if ($Ollama) { "Green" } else { "Red" })
  Write-Host ("  Qwen model   {0}" -f $(if ($ModelInstalled) { "ready" } else { "missing" })) -ForegroundColor $(if ($ModelInstalled) { "Green" } else { "Red" })
  Write-Host ("  Detector     {0}" -f $Report.detector.state) -ForegroundColor $(if ($Detector) { "Green" } else { "Red" })
  Write-Host ("  Temporal     {0} ({1})" -f $Report.temporal.state, $Report.temporal.rollout) -ForegroundColor $(if ($Report.temporal.state -eq "ready") { "Green" } else { "Red" })
  Write-Host ("  Accelerator  {0}" -f $Report.detector.accelerator)
  Write-Host ("  Queue         {0}" -f $Report.detector.queueDepth)
  Write-Host ("  Visual mode   {0}" -f $Report.detector.visualRolloutMode) -ForegroundColor $(if ($Report.detector.automaticFiltering) { "Green" } else { "Yellow" })
  Write-Host ("  Fact checker  {0}" -f $Report.factChecker.state) -ForegroundColor $(if ($Report.factChecker.configured) { "Green" } else { "Yellow" })
  Write-Host ("  Origin lock   {0}" -f $(if ($OriginLocked -and $OriginlessDisabled) { "production" } else { "development" })) -ForegroundColor $(if ($OriginLocked -and $OriginlessDisabled) { "Green" } else { "Yellow" })
  Write-Host ""
  Write-Host $(if ($Report.ready) { "  Ready for protected browsing." } elseif (-not $Report.factChecker.configured) { "  Core protection is online. Finish evidence setup: pnpm fact-check:setup" } elseif (-not $OriginLocked -or -not $OriginlessDisabled) { "  Lock the bridge to your extension: pnpm extension-origin:setup" } else { "  Setup needs attention. Run: pnpm orislop:start" }) -ForegroundColor $(if ($Report.ready) { "Green" } else { "Yellow" })
  Write-Host ""
}

if (-not $Report.ready) { exit 1 }
