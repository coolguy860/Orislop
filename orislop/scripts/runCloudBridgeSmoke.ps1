param(
  [int]$Port = 4318,
  [string]$Origin = "chrome-extension://nbgdcimhnlnjpjomffegjbdemdojcagg"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $RepoRoot ".venv-detector\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
  throw "Detector environment is missing. Run pnpm detector:setup first."
}

$TokenBytes = New-Object byte[] 32
$Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $Generator.GetBytes($TokenBytes)
} finally {
  $Generator.Dispose()
}
$Token = ([System.BitConverter]::ToString($TokenBytes)).Replace("-", "").ToLowerInvariant()

$env:ORISLOP_DETECTOR_HOST = "127.0.0.1"
$env:ORISLOP_DETECTOR_PORT = [string]$Port
$env:ORISLOP_REQUIRE_API_AUTH = "1"
$env:ORISLOP_API_TOKENS = $Token
$env:ORISLOP_ALLOWED_EXTENSION_ORIGINS = $Origin
$env:ORISLOP_ALLOW_ORIGINLESS_POSTS = "0"

$Process = Start-Process -FilePath $Python `
  -ArgumentList (Join-Path $RepoRoot "apps\detector-bridge\server.py") `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -PassThru

try {
  $BaseUrl = "http://127.0.0.1:$Port"
  $Headers = @{ Origin = $Origin; Authorization = "Bearer $Token" }
  $Health = $null
  for ($Attempt = 0; $Attempt -lt 60; $Attempt += 1) {
    try {
      $Health = Invoke-RestMethod -Uri "$BaseUrl/health" -Headers $Headers -TimeoutSec 5
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $Health -or -not $Health.ok) { throw "Authenticated cloud-style health check did not become ready." }

  $Rejected = $false
  try {
    Invoke-RestMethod -Uri "$BaseUrl/health" -Headers @{ Origin = $Origin; Authorization = "Bearer wrong-token" } -TimeoutSec 5 | Out-Null
  } catch {
    $Rejected = $_.Exception.Response.StatusCode.value__ -eq 401
  }
  if (-not $Rejected) { throw "Cloud-style API did not reject an invalid bearer token." }

  $Body = @{
    model = "qwen2.5:1.5b-instruct"
    candidates = @(@{
      id = "cloud-smoke"
      platform = "youtube"
      title = "How black holes bend light"
      channelName = "Physics Classroom"
      visibleText = "A professor explains gravitational lensing with a diagram and cites the observation."
      transcriptText = "This lesson explains how mass curves spacetime and bends the path of light."
    })
  } | ConvertTo-Json -Depth 5
  $TextResult = Invoke-RestMethod -Uri "$BaseUrl/v1/text-score" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 120
  $Decision = $TextResult.results | Select-Object -First 1
  if (-not $TextResult.ok -or -not $Decision.available -or $Decision.verdict -notin @("skip", "dont_skip")) {
    throw "Authenticated cloud-style Qwen inference did not return a valid decision."
  }

  $ExplanationBody = @{
    model = "qwen2.5:1.5b-instruct"
    mode = "explain"
    candidate = @{
      itemKey = "youtube:cloud-explain"
      platform = "youtube"
      title = "Why rainbows form"
      channelName = "Physics Classroom"
      visibleText = "A teacher explains how sunlight separates into colors inside water droplets."
      transcriptText = "Light refracts as it enters a droplet, reflects inside it, and refracts again as it exits. Different wavelengths bend by different amounts."
    }
    decision = @{
      recommendation = "watch"
      reasons = @("Educational explanation")
      factCheck = @{ verdict = ""; sources = @() }
    }
  } | ConvertTo-Json -Depth 6
  $Explanation = Invoke-RestMethod -Uri "$BaseUrl/v1/explain" -Method Post -Headers $Headers -ContentType "application/json" -Body $ExplanationBody -TimeoutSec 120
  if (-not $Explanation.ok -or [string]::IsNullOrWhiteSpace($Explanation.explanation)) {
    throw "Authenticated cloud-style explanation endpoint did not return a valid explanation."
  }

  [pscustomobject]@{
    ok = $true
    invalidTokenRejected = $Rejected
    textModel = $Health.text_model.model
    accelerator = $Health.accelerator
    verdict = $Decision.verdict
    confidence = $Decision.confidence
    explanationHeading = $Explanation.heading
  } | ConvertTo-Json -Depth 3
} finally {
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
  }
}
