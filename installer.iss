; Installeur Windows d'Onde (Inno Setup) — construit automatiquement par GitHub Actions
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{8F3B2C1D-6A4E-4F7B-9C2D-0E1A5B7C9D3F}
AppName=Onde
AppVersion={#AppVersion}
AppVerName=Onde {#AppVersion}
AppPublisher=nayzen-bot
AppPublisherURL=https://github.com/nayzen-bot/onde
AppSupportURL=https://github.com/nayzen-bot/onde/issues
DefaultDirName={localappdata}\Programs\Onde
DefaultGroupName=Onde
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=Onde-Setup
SetupIconFile=onde.ico
UninstallDisplayIcon={app}\Onde.exe
UninstallDisplayName=Onde
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Lancer Onde au démarrage de Windows"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\Onde\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; on repart propre à chaque mise à jour (tes sons et réglages sont dans Musique\Onde, ils ne bougent pas)
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Onde"; Filename: "{app}\Onde.exe"
Name: "{autodesktop}\Onde"; Filename: "{app}\Onde.exe"; Tasks: desktopicon
Name: "{userstartup}\Onde"; Filename: "{app}\Onde.exe"; Tasks: startup

[Run]
Filename: "{app}\Onde.exe"; Description: "{cm:LaunchProgram,Onde}"; Flags: nowait postinstall skipifsilent
