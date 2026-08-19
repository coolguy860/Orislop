$Bytes = New-Object byte[] 32
$Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $Generator.GetBytes($Bytes)
} finally {
  $Generator.Dispose()
}
$Token = ([System.BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
Write-Host "Generated Orislop cloud testing token:" -ForegroundColor Green
Write-Output $Token
Write-Host "Store this only in your cloud secret manager and the test extension. Do not commit it." -ForegroundColor Yellow
