$ErrorActionPreference = "Stop"
$TaskName = "Orislop Companion"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the Orislop Companion logon task." -ForegroundColor Green
} else {
  Write-Host "The Orislop Companion logon task is not installed." -ForegroundColor Yellow
}

