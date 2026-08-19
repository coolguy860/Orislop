#define AppName "Orislop Companion"
#define AppVersion "1.0.0-beta.1"
#define AppPublisher "Orislop"
#define AppExeName "orislop-companion.exe"

[Setup]
AppId={{839681C8-80D2-4AD8-9A4A-4F0B56646A73}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Orislop
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\windows
OutputBaseFilename=Orislop-Companion-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}
CloseApplications=no

[Files]
Source: "..\..\dist\windows\orislop-companion\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "configure-companion.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Code]
var
  ExtensionPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ExtensionPage := CreateInputQueryPage(wpSelectDir,
    'Chrome extension', 'Enter the stable unlisted Chrome Web Store extension ID.',
    'Orislop allows only this exact extension origin to contact the loopback companion.');
  ExtensionPage.Add('Extension ID:', False);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Value: String;
  Index: Integer;
begin
  Result := True;
  if CurPageID = ExtensionPage.ID then begin
    Value := Lowercase(Trim(ExtensionPage.Values[0]));
    Result := Length(Value) = 32;
    if Result then
      for Index := 1 to Length(Value) do
        if not (Value[Index] in ['a'..'p']) then Result := False;
    if not Result then MsgBox('Enter the 32-character Chrome extension ID.', mbError, MB_OK);
  end;
end;

function GetExtensionId(Param: String): String;
begin
  Result := Lowercase(Trim(ExtensionPage.Values[0]));
end;

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\configure-companion.ps1"" -ExtensionId ""{code:GetExtensionId}"" -InstallDirectory ""{app}"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Unregister-ScheduledTask -TaskName 'Orislop Local Fast' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden
