[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:4317"
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
[pscustomobject]@{
    service = $health.service
    version = $health.version
    accelerator = $health.accelerator
    state = $health.state
    security = $health.security
    visualRollout = $health.visual_rollout
    modelStates = $health.model_states
    textModel = $health.text_model
} | ConvertTo-Json -Depth 10
