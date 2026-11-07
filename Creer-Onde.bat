@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ~ Onde ~  creation de l'application...
echo.
rem -U : yt-dlp est mis a jour a chaque creation (YouTube change souvent)
python -m pip install --quiet --disable-pip-version-check -U pywebview pyinstaller pillow pystray "yt-dlp[default]" imageio-ffmpeg
if not exist public\icon.png python make_icon.py
python -m PyInstaller --noconfirm --clean --windowed --onefile --name Onde --icon onde.ico --add-data "public;public" --collect-all imageio_ffmpeg --collect-all yt_dlp_ejs --collect-submodules yt_dlp --collect-all pystray --hidden-import pystray._win32 onde.py
if errorlevel 1 (
  echo.
  echo   La creation a echoue. Regarde les messages au-dessus.
  pause
  exit /b 1
)
copy /y "dist\Onde.exe" "Onde.exe" >nul

rem Raccourcis Bureau + menu Demarrer
powershell -NoProfile -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $s = $w.CreateShortcut((Join-Path $dir 'Onde.lnk'));" ^
  "  $s.TargetPath = (Resolve-Path 'Onde.exe').Path; $s.WorkingDirectory = (Get-Location).Path;" ^
  "  $s.IconLocation = (Resolve-Path 'Onde.exe').Path + ',0'; $s.Description = 'Onde - lecteur de musique'; $s.Save() }"

echo.
echo   C'est pret : Onde.exe + raccourci sur le Bureau et dans le menu Demarrer.
echo.
pause
