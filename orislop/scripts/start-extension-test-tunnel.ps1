[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SshTarget,

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"
$localPort = 4317

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw "OpenSSH is not installed or ssh.exe is not on PATH."
}

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$localPort/health" -Method Get -TimeoutSec 3
        if ($health.service -eq "orislop-detector-bridge") {
            Write-Host "Orislop is already reachable on 127.0.0.1:$localPort." -ForegroundColor Green
            exit 0
        }
    } catch {
        # The explicit error below identifies the collision without exposing details.
    }
    throw "Local port $localPort is already in use by another process."
}

$sshArguments = @(
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:${localPort}:127.0.0.1:${localPort}",
    "-p", "$SshPort"
)
if ($IdentityFile) {
    $resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
    $sshArguments += @("-i", $resolvedIdentity)
}
$sshArguments += $SshTarget

Write-Host "Opening the private Orislop tunnel on http://127.0.0.1:$localPort" -ForegroundColor Cyan
Write-Host "Keep this window open while testing. Ctrl+C closes the tunnel." -ForegroundColor Yellow
Write-Host "Port 4317 must not be exposed in the Vast public-port list." -ForegroundColor Yellow
& ssh @sshArguments
if ($LASTEXITCODE -ne 0) {
    throw "The SSH tunnel exited with status $LASTEXITCODE."
}
