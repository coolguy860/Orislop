[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DynamicIP,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$SshPort,

    [ValidateNotNullOrEmpty()]
    [string]$Username = "root",

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$IdentityFile,

    [ValidateRange(1, 65535)]
    [int]$LocalPort = 4317,

    [ValidateRange(1, 65535)]
    [int]$RemotePort = 4317
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw "OpenSSH is not installed. Install the Windows OpenSSH Client feature and try again."
}
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "The SSH private-key file was not found. Choose the key registered with your Vast account."
}
$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    try {
        $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/ready" -Method Get -TimeoutSec 3
        if ($ready.service -eq "orislop-detector-bridge") {
            Write-Host "Orislop is already reachable on 127.0.0.1:$LocalPort (state=$($ready.state))." -ForegroundColor Green
            exit 0
        }
    } catch {
        # The explicit collision message below is friendlier than the raw socket error.
    }
    throw "Local port $LocalPort is already in use by another program. Close it or choose a different -LocalPort."
}

$sshArguments = @(
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}",
    "-p", "$SshPort",
    "-i", $resolvedIdentity,
    "${Username}@${DynamicIP}"
)

Write-Host "Opening a private Orislop tunnel on http://127.0.0.1:$LocalPort" -ForegroundColor Cyan
Write-Host "Remote destination: 127.0.0.1:$RemotePort through ${Username}@${DynamicIP}:$SshPort" -ForegroundColor Cyan
Write-Host "Keep this window open while testing. Ctrl+C closes only the tunnel." -ForegroundColor Yellow
Write-Host "Do not add detector port $RemotePort to the Vast public-port list." -ForegroundColor Yellow
& ssh @sshArguments
if ($LASTEXITCODE -ne 0) {
    throw "The private SSH tunnel could not start (ssh exit $LASTEXITCODE). Check the dynamic IP, mapped SSH port, username, and key. Password prompts are intentionally disabled."
}
