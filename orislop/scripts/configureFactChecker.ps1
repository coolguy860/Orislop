param(
  [ValidateSet("Brave", "Google", "Both")]
  [string]$Provider = "",
  [ValidateSet("Development", "Installed", "Both")]
  [string]$Scope = "Both"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DevelopmentTarget = Join-Path $RepoRoot "apps\detector-bridge\.env.local"
$InstalledTarget = Join-Path $env:LOCALAPPDATA "Orislop\.env.local"

if (-not $Provider) {
  $Provider = Read-Host "Provider (Brave, Google, or Both)"
}
if ($Provider -notin @("Brave", "Google", "Both")) {
  throw "Provider must be Brave, Google, or Both."
}

function Read-SecretValue {
  param([string]$Prompt)
  $Secure = Read-Host $Prompt -AsSecureString
  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
  }
}

$NewValues = [ordered]@{}
if ($Provider -in @("Brave", "Both")) {
  $Value = Read-SecretValue "Brave Search API key"
  if (-not $Value) { throw "The Brave Search API key cannot be empty." }
  $NewValues["BRAVE_SEARCH_API_KEY"] = $Value
}
if ($Provider -in @("Google", "Both")) {
  $Value = Read-SecretValue "Google Fact Check Tools API key"
  if (-not $Value) { throw "The Google Fact Check Tools API key cannot be empty." }
  $NewValues["GOOGLE_FACT_CHECK_API_KEY"] = $Value
}

function Save-EnvironmentFile {
  param([string]$Target)
  $Values = [ordered]@{}
  if (Test-Path -LiteralPath $Target) {
    foreach ($Line in Get-Content -LiteralPath $Target) {
      if ($Line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $Values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
      }
    }
  }
  foreach ($Entry in $NewValues.GetEnumerator()) {
    $Values[$Entry.Key] = $Entry.Value
  }
  $Parent = Split-Path -Parent $Target
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  $Lines = @(
    "# Local Orislop secrets. This file is ignored by Git."
    "# Restart the detector bridge after changing these values."
  )
  foreach ($Entry in $Values.GetEnumerator()) {
    $Lines += "$($Entry.Key)=$($Entry.Value)"
  }
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines($Target, $Lines, $Utf8NoBom)
}

if ($Scope -in @("Development", "Both")) { Save-EnvironmentFile $DevelopmentTarget }
if ($Scope -in @("Installed", "Both")) { Save-EnvironmentFile $InstalledTarget }

Write-Host ""
Write-Host "Fact-check provider saved for $Scope mode." -ForegroundColor Green
Write-Host "Restart Orislop to activate it:"
Write-Host "  pnpm orislop:stop"
Write-Host "  pnpm orislop:start"
