[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:4317",

    [string]$VideoUrl = "",

    [ValidateSet("fast", "balanced", "heavy")]
    [string]$PerformanceProfile = "heavy",

    [ValidateRange(30, 3600)]
    [int]$VideoTimeoutSeconds = 900,

    [ValidateRange(1, 30)]
    [int]$PollSeconds = 2
)

$ErrorActionPreference = "Stop"
$expectedOrigin = "chrome-extension://nhkffdhagjignajnmlgkgekpkfljhfdd"
$headers = @{ Origin = $expectedOrigin }

$health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -Headers $headers -TimeoutSec 15
$ready = Invoke-RestMethod -Uri "$BaseUrl/ready" -Method Get -Headers $headers -TimeoutSec 15

if ($health.ok -ne $true -or $health.service -ne "orislop-detector-bridge") {
    throw "The endpoint responded, but it is not a healthy Orislop detector bridge."
}
if ($health.security.network -ne "loopback-only") {
    throw "Unsafe test configuration: the detector does not report loopback-only networking."
}
if ($health.security.extension_origin_policy -ne "allowlist") {
    throw "Unsafe test configuration: the fixed extension origin is not allowlisted."
}
if ($ready.ok -ne $true) {
    throw "Orislop is reachable but not ready. Check the Vast launcher output and model_states below.`n$($health.model_states | ConvertTo-Json -Depth 8)"
}

Write-Host "PASS: private bridge is ready for the packaged extension." -ForegroundColor Green
$report = [ordered]@{
    service = $health.service
    version = $health.version
    accelerator = $health.accelerator
    state = $health.state
    security = $health.security
    visualRollout = $health.visual_rollout
    modelStates = $health.model_states
    textModel = $health.text_model
    executionScheduler = $health.execution_scheduler
}

if (-not [string]::IsNullOrWhiteSpace($VideoUrl)) {
    $absoluteVideo = $null
    if (-not [Uri]::TryCreate($VideoUrl, [UriKind]::Absolute, [ref]$absoluteVideo) -or $absoluteVideo.Scheme -notin @("http", "https")) {
        throw "VideoUrl must be an absolute http:// or https:// URL."
    }

    $candidateId = "private-gpu-smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $body = @{
        performanceProfile = $PerformanceProfile
        candidates = @(@{
            id = $candidateId
            url = $absoluteVideo.AbsoluteUri
            mediaUrl = ""
            previewUrl = ""
            language = "unknown"
            priority = 10
            duration = 0
            playbackPosition = 0
        })
    } | ConvertTo-Json -Depth 6 -Compress

    Write-Host "Running a real $PerformanceProfile video analysis through the private tunnel..." -ForegroundColor Cyan
    $started = [DateTimeOffset]::UtcNow
    $deadline = $started.AddSeconds($VideoTimeoutSeconds)
    $decision = $null
    $responseState = "pending"

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $response = Invoke-RestMethod `
            -Uri "$BaseUrl/v1/analyze" `
            -Method Post `
            -Headers $headers `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec ([Math]::Min(180, $VideoTimeoutSeconds))
        if ($response.ok -ne $true -or -not $response.results -or $response.results.Count -lt 1) {
            throw "The Heavy video endpoint returned an invalid response."
        }

        $responseState = [string]$response.state
        $decision = $response.results | Select-Object -First 1
        $status = [string]$decision.status
        if ($status -in @("ready", "error", "unavailable")) {
            break
        }
        Start-Sleep -Seconds $PollSeconds
    }

    if (-not $decision) {
        throw "The Heavy video endpoint returned no decision."
    }
    if ([string]$decision.status -ne "ready") {
        throw "Heavy video analysis did not settle successfully. status=$($decision.status) state=$responseState error=$($decision.error)"
    }
    if ($decision.available -ne $true) {
        throw "Heavy video analysis settled without usable media evidence. Try a public video URL that is reachable from the GPU host."
    }

    $elapsed = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalSeconds, 3)
    $report.videoSmoke = [ordered]@{
        ok = $true
        profile = $PerformanceProfile
        elapsedSeconds = $elapsed
        responseState = $responseState
        decision = $decision
    }
    Write-Host "PASS: real $PerformanceProfile video analysis settled in $elapsed seconds." -ForegroundColor Green
}

[pscustomobject]$report | ConvertTo-Json -Depth 14
