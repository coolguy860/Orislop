param(
  [Parameter(Mandatory = $true)]
  [string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$python = Join-Path $root '.venv-detector\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run pnpm detector:setup before building the companion.' }

if ($CertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'CertificateThumbprint must be a 40-character SHA-1 certificate thumbprint.' }
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
if (-not $certificate) { throw "Code-signing certificate was not found in Cert:\CurrentUser\My\$CertificateThumbprint." }
if (-not $certificate.HasPrivateKey) { throw 'The code-signing certificate does not have an accessible private key.' }
if ($certificate.NotAfter -le (Get-Date)) { throw 'The code-signing certificate has expired.' }

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) { throw 'signtool.exe is missing. Install the Windows SDK and add its bin directory to PATH.' }
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  $defaultIscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (Test-Path -LiteralPath $defaultIscc) { $iscc = Get-Item -LiteralPath $defaultIscc }
}
if (-not $iscc) { throw 'ISCC.exe is missing. Install Inno Setup 6.' }

& $python -m pip install 'pyinstaller==6.14.2'
& $python -m PyInstaller --noconfirm --clean --distpath (Join-Path $root 'dist\windows') (Join-Path $root 'apps\windows-companion\OrislopCompanion.spec')

$companion = Join-Path $root 'dist\windows\orislop-companion\orislop-companion.exe'
& $signtool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $companion
if ($LASTEXITCODE -ne 0) { throw 'Signing the companion executable failed.' }

$isccPath = if ($iscc.Source) { $iscc.Source } else { $iscc.FullName }
& $isccPath (Join-Path $root 'apps\windows-companion\OrislopBootstrapper.iss')
if ($LASTEXITCODE -ne 0) { throw 'Building the Inno Setup installer failed.' }
$installer = Join-Path $root 'dist\windows\Orislop-Companion-Setup.exe'
& $signtool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $installer
if ($LASTEXITCODE -ne 0) { throw 'Signing the companion installer failed.' }
Write-Host "Signed installer ready: $installer"
