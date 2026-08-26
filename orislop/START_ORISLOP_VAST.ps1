[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DynamicIP,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$SshPort,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$IdentityFile,

    [ValidateNotNullOrEmpty()]
    [string]$Username = "root",

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
    Write-Host "[Orislop] $Message" -ForegroundColor Cyan
}

function Stop-Friendly([string]$Message) {
    throw "Orislop could not start: $Message"
}

function Invoke-CheckedNative {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Program,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-Friendly "$FailureMessage (exit $LASTEXITCODE)."
    }
}

$projectRoot = $PSScriptRoot
$packageName = "orislop_extension_test_ready_v4_production"
$localArchive = Join-Path (Split-Path -Parent $projectRoot) "$packageName.zip"
$remoteWorkspace = "/workspace"
$remoteArchive = "$remoteWorkspace/$packageName.zip"
$remoteBootstrap = "$remoteWorkspace/orislop-v4-remote-bootstrap.sh"
$bootstrapScript = Join-Path $projectRoot "scripts\bootstrap-vast-from-windows.sh"
$tunnelScript = Join-Path $projectRoot "scripts\start-extension-test-tunnel.ps1"
$extensionFolder = Join-Path $projectRoot "apps\extension\dist"
$extensionManifest = Join-Path $extensionFolder "manifest.json"

foreach ($program in @("ssh", "scp")) {
    if (-not (Get-Command $program -ErrorAction SilentlyContinue)) {
        Stop-Friendly "Windows OpenSSH is missing '$program'. Install the OpenSSH Client feature, then run the same command again."
    }
}
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    Stop-Friendly "the private key was not found at '$IdentityFile'. Use the key registered with this Vast account."
}
if (-not (Test-Path -LiteralPath $localArchive -PathType Leaf)) {
    Stop-Friendly "the deployment ZIP is missing at '$localArchive'. Keep the v4 folder and v4 ZIP beside each other."
}
if (-not (Test-Path -LiteralPath $bootstrapScript -PathType Leaf)) {
    Stop-Friendly "the remote bootstrap helper is missing from the v4 package."
}
if (-not (Test-Path -LiteralPath $tunnelScript -PathType Leaf)) {
    Stop-Friendly "the private-tunnel helper is missing from the v4 package."
}
if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) {
    Stop-Friendly "the built extension is missing at '$extensionFolder'."
}

$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
$target = "${Username}@${DynamicIP}"
$commonOptions = @(
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-i", $resolvedIdentity
)

if ($DryRun) {
    Write-Host "Orislop one-command launch check" -ForegroundColor Green
    Write-Host "  Local ZIP:       $localArchive"
    Write-Host "  Vast SSH target: $target (mapped SSH port $SshPort)"
    Write-Host "  Remote project:  $remoteWorkspace/$packageName"
    Write-Host "  Private endpoint: http://127.0.0.1:4317"
    Write-Host "  Extension folder: $extensionFolder"
    Write-Host "No network connection was made because -DryRun was selected." -ForegroundColor Yellow
    exit 0
}

Write-Step "Uploading the resumable v4 package to the Vast instance..."
$scpOptions = $commonOptions + @("-P", "$SshPort")
Invoke-CheckedNative -Program "scp" -Arguments ($scpOptions + @($localArchive, "${target}:$remoteArchive")) -FailureMessage "the package upload failed. Check the dynamic IP, the port mapped to 22/tcp (not the Machine Copy Port), and the registered SSH key"
Invoke-CheckedNative -Program "scp" -Arguments ($scpOptions + @($bootstrapScript, "${target}:$remoteBootstrap")) -FailureMessage "the bootstrap upload failed"

Write-Step "Starting or resuming the detached GPU service and waiting for real readiness..."
$sshOptions = $commonOptions + @("-p", "$SshPort")
Invoke-CheckedNative -Program "ssh" -Arguments ($sshOptions + @($target, "bash", $remoteBootstrap, $remoteWorkspace)) -FailureMessage "the remote GPU launcher failed. If it reports a missing HF_TOKEN, add a newly rotated read token to the Vast instance's private environment and rerun this same command"

Write-Host "" 
Write-Host "GPU service is ready." -ForegroundColor Green
Write-Host "Chrome extension folder (Load unpacked):" -ForegroundColor Green
Write-Host "  $extensionFolder"
Write-Host "The private tunnel will stay in this window. Keep it open while testing; Ctrl+C closes the tunnel only." -ForegroundColor Yellow
Write-Host ""

& $tunnelScript -DynamicIP $DynamicIP -SshPort $SshPort -Username $Username -IdentityFile $resolvedIdentity
if ($LASTEXITCODE -ne 0) {
    Stop-Friendly "the GPU service started, but the private tunnel failed. Rerun the same command; the remote setup will resume instead of starting duplicates."
}
