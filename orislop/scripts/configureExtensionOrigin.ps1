param(
  [string]$ExtensionId = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Target = Join-Path $RepoRoot "apps\detector-bridge\.env.local"

if (-not $ExtensionId) {
  $ExtensionId = Read-Host "Chrome/Brave extension ID (32 letters shown on the extensions page)"
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId.StartsWith("chrome-extension://")) {
  $ExtensionId = $ExtensionId.Substring("chrome-extension://".Length).TrimEnd("/")
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "Extension ID must be exactly 32 lowercase letters from a through p. Copy it from chrome://extensions or brave://extensions."
}

$Values = [ordered]@{}
if (Test-Path -LiteralPath $Target) {
  foreach ($Line in Get-Content -LiteralPath $Target) {
    if ($Line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $Values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
}

$Values["ORISLOP_ALLOWED_EXTENSION_ORIGINS"] = "chrome-extension://$ExtensionId"
$Values["ORISLOP_ALLOW_ORIGINLESS_POSTS"] = "0"

$Lines = @(
  "# Local Orislop secrets and runtime policy. This file is ignored by Git."
  "# Restart the detector bridge after changing these values."
)
foreach ($Entry in $Values.GetEnumerator()) {
  $Lines += "$($Entry.Key)=$($Entry.Value)"
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($Target, $Lines, $Utf8NoBom)

Write-Host ""
Write-Host "Extension origin locked to chrome-extension://$ExtensionId" -ForegroundColor Green
Write-Host "Originless POST requests are disabled."
Write-Host "Restart Orislop to activate the policy:"
Write-Host "  pnpm orislop:stop"
Write-Host "  pnpm orislop:start"
