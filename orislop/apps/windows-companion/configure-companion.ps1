param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [Parameter(Mandatory = $true)]
  [string]$InstallDirectory
)

$ErrorActionPreference = 'Stop'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'Orislop'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$environmentPath = Join-Path $dataDirectory '.env.local'
$environmentValues = [ordered]@{}
if (Test-Path -LiteralPath $environmentPath) {
  foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $environmentValues[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
}
$environmentValues['ORISLOP_DETECTOR_HOST'] = '127.0.0.1'
$environmentValues['ORISLOP_DETECTOR_PORT'] = '4317'
$environmentValues['ORISLOP_REQUIRE_API_AUTH'] = '0'
$environmentValues['ORISLOP_ALLOWED_EXTENSION_ORIGINS'] = "chrome-extension://$ExtensionId"
$environmentValues['ORISLOP_CLOUD_HEAVY_ENABLED'] = '0'
$environmentValues['ORISLOP_PRELOAD_HEAVY_MODE'] = '0'
$environment = ($environmentValues.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
[System.IO.File]::WriteAllText($environmentPath, "$environment`r`n", [System.Text.UTF8Encoding]::new($false))

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Ollama is missing and winget is unavailable.' }
  & $winget.Source install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
  $ollama = Get-Command ollama -ErrorAction SilentlyContinue
  if (-not $ollama) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $candidate) { $ollama = Get-Item -LiteralPath $candidate }
  }
}
if (-not $ollama) { throw 'Ollama installation did not provide ollama.exe.' }
$ollamaPath = if ($ollama.Source) { $ollama.Source } else { $ollama.FullName }
if (-not $ollamaPath -or -not (Test-Path -LiteralPath $ollamaPath)) { throw 'Ollama executable could not be resolved.' }
& $ollamaPath pull 'qwen2.5:1.5b-instruct'
if ($LASTEXITCODE -ne 0) { throw 'Ollama could not install the required qwen2.5:1.5b-instruct model.' }

$executable = Join-Path $InstallDirectory 'orislop-companion.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw "Companion executable not found: $executable" }
$action = New-ScheduledTaskAction -Execute $executable -WorkingDirectory $InstallDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Orislop Local Fast' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the Orislop loopback Local Fast companion.' -Force | Out-Null
Start-Process -FilePath $executable -WorkingDirectory $InstallDirectory -WindowStyle Hidden
