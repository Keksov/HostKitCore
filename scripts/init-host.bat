@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem GCY2.1 (plan gnauralcity, GCY-D17, GCY-D37): installation of a host of the workspace -- moved here
rem from MindWaveCore\server\init-dev.bat (now a thin wrapper over this file) and generalized: the host
rem is an ARGUMENT, HostKitCore knows no host (GCY-D19).
rem
rem   init-host.bat HOST_SERVER_DIR      e.g.  init-host.bat C:\work\KKMindWave\Gnauralcity\server
rem
rem The host's ui\ is ..\ui next to its server\. What it does, in order:
rem   1. bun.exe in the server dir: the host's own when it runs; else a COPY of a neighbour host's
rem      (WORKSPACE\REPO\server\bun.exe -- every host of the workspace on one Bun version); else the
rem      latest release from GitHub, through the cache of VendorsCore\common\win\release_asset_download.bat
rem      (HOST_SERVER_DIR\tmp\bun) when VendorsCore is there, else a plain download;
rem   2. bun install in the server dir, then in the ui dir.
rem HK_DRY_RUN=1 (old name MW_DRY_RUN, read second -- GCY-D38) prints the paths and does nothing.

if "%~1"=="" (
    echo [init-host] Usage: init-host.bat ^<host server dir^>
    exit /b 2
)
for %%I in ("%~1") do set "HOST_SERVER_DIR=%%~fI"
if "%HOST_SERVER_DIR:~-1%"=="\" set "HOST_SERVER_DIR=%HOST_SERVER_DIR:~0,-1%"
if not exist "%HOST_SERVER_DIR%\package.json" (
    echo [init-host] Not a host server directory ^(no package.json^): %HOST_SERVER_DIR%
    exit /b 2
)
set "HOST_DIR=%HOST_SERVER_DIR%\"
set "HOST_SERVER_DIR=%HOST_SERVER_DIR%\"
set "UI_DIR=%HOST_DIR%..\ui"
set "BUN_EXE=%HOST_SERVER_DIR%bun.exe"
for %%I in ("%~dp0..\..") do set "WORKSPACE_DIR=%%~fI"
set "BUN_URL=https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip"
set "BUN_RELEASE_REPO=oven-sh/bun"
set "BUN_ASSET_NAME=bun-windows-x64.zip"
set "BUN_CACHE_DIR=%HOST_SERVER_DIR%tmp\bun"
set "BUN_CACHE_ZIP=%BUN_CACHE_DIR%\%BUN_ASSET_NAME%"
set "BUN_VERSION=unknown"
set "SERVER_STATUS=not started"
set "UI_STATUS=not started"
set "BUN_SOURCE=existing"
for %%I in ("%WORKSPACE_DIR%\VendorsCore\common\win") do set "COMMON_WIN_DIR=%%~fI"
set "RELEASE_ASSET_DOWNLOAD=%COMMON_WIN_DIR%\release_asset_download.bat"
set "NEIGHBOUR_BUN="

set "DRY_RUN=%HK_DRY_RUN%"
if not defined DRY_RUN set "DRY_RUN=%MW_DRY_RUN%"
if /I "%DRY_RUN%"=="1" (
    echo HOST_DIR=%HOST_DIR%
    echo HOST_SERVER_DIR=%HOST_SERVER_DIR%
    echo UI_DIR=%UI_DIR%
    echo BUN_EXE=%BUN_EXE%
    echo WORKSPACE_DIR=%WORKSPACE_DIR%
    echo RELEASE_ASSET_DOWNLOAD=%RELEASE_ASSET_DOWNLOAD%
    exit /b 0
)

call :ensure_bun
if errorlevel 1 goto :fail

call :install_server_deps
if errorlevel 1 goto :fail

call :install_ui_deps
if errorlevel 1 goto :fail

call :print_summary
exit /b 0

:fail
echo [init-host] Setup failed.
exit /b 1

:ensure_bun
if exist "%BUN_EXE%" (
    "%BUN_EXE%" --version >nul 2>nul
    if errorlevel 1 (
        echo [init-host] Existing bun.exe is invalid. Looking for a neighbour host's copy...
        call :obtain_bun
        if errorlevel 1 exit /b 1
    ) else (
        echo [init-host] Using existing local Bun: %BUN_EXE%
    )
) else (
    echo [init-host] Local bun.exe was not found. Looking for a neighbour host's copy...
    call :obtain_bun
    if errorlevel 1 exit /b 1
)

call :capture_bun_version
if errorlevel 1 exit /b 1
exit /b 0

rem A neighbour host's bun.exe first: the hosts of one workspace stay on ONE Bun version. Only when
rem no neighbour has a working one, the latest release is downloaded.
:obtain_bun
for /d %%D in ("%WORKSPACE_DIR%\*") do (
    if not defined NEIGHBOUR_BUN if /I not "%%~fD\server\"=="%HOST_SERVER_DIR%" if exist "%%~fD\server\bun.exe" call :try_neighbour_bun "%%~fD\server\bun.exe"
)
if defined NEIGHBOUR_BUN (
    set "BUN_SOURCE=copied from %NEIGHBOUR_BUN%"
    exit /b 0
)
echo [init-host] No neighbour host has a working bun.exe. Downloading...
set "BUN_SOURCE=downloaded"
call :download_bun
exit /b %errorlevel%

:try_neighbour_bun
"%~1" --version >nul 2>nul
if errorlevel 1 exit /b 0
copy /y "%~1" "%BUN_EXE%" >nul
if errorlevel 1 (
    echo [init-host] Failed to copy %~1 into %HOST_SERVER_DIR%
    exit /b 0
)
"%BUN_EXE%" --version >nul 2>nul
if errorlevel 1 exit /b 0
set "NEIGHBOUR_BUN=%~1"
echo [init-host] Copied Bun from a neighbour host: %~1
exit /b 0

:download_bun
set "TEMP_DIR=%TEMP%\hostkit-bun-%RANDOM%%RANDOM%"
set "ARCHIVE_PATH=%BUN_CACHE_ZIP%"

if exist "%TEMP_DIR%" rd /s /q "%TEMP_DIR%" >nul 2>nul

if exist "%RELEASE_ASSET_DOWNLOAD%" (
    if not exist "%BUN_CACHE_DIR%" mkdir "%BUN_CACHE_DIR%"
    if errorlevel 1 (
        echo [init-host] Failed to create Bun cache directory: %BUN_CACHE_DIR%
        exit /b 1
    )
) else (
    set "ARCHIVE_PATH=%TEMP%\hostkit-bun-%RANDOM%%RANDOM%.zip"
    if exist "%ARCHIVE_PATH%" del /f /q "%ARCHIVE_PATH%" >nul 2>nul
)

mkdir "%TEMP_DIR%"
if errorlevel 1 (
    echo [init-host] Failed to create temp directory: %TEMP_DIR%
    exit /b 1
)

if exist "%RELEASE_ASSET_DOWNLOAD%" (
    echo [init-host] Preparing cached Bun archive...
    call "%RELEASE_ASSET_DOWNLOAD%" --repo "%BUN_RELEASE_REPO%" --asset "%BUN_ASSET_NAME%" --out "%ARCHIVE_PATH%" --latest
    if errorlevel 1 (
        echo [init-host] Failed to prepare cached Bun archive.
        call :cleanup_download "" "%TEMP_DIR%"
        exit /b 1
    )
) else (
    echo [init-host] Downloading Bun archive...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%BUN_URL%' -OutFile '%ARCHIVE_PATH%'"
    if errorlevel 1 (
        echo [init-host] Failed to download Bun from %BUN_URL%
        call :cleanup_download "%ARCHIVE_PATH%" "%TEMP_DIR%"
        exit /b 1
    )
)

echo [init-host] Extracting Bun archive...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ARCHIVE_PATH%' -DestinationPath '%TEMP_DIR%' -Force"
if errorlevel 1 (
    echo [init-host] Failed to extract Bun archive.
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

if not exist "%TEMP_DIR%\bun-windows-x64\bun.exe" (
    echo [init-host] Extracted archive did not contain bun-windows-x64\bun.exe
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

copy /y "%TEMP_DIR%\bun-windows-x64\bun.exe" "%BUN_EXE%" >nul
if errorlevel 1 (
    echo [init-host] Failed to copy bun.exe into %HOST_SERVER_DIR%
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

if /I "%ARCHIVE_PATH%"=="%BUN_CACHE_ZIP%" (
    call :cleanup_download "" "%TEMP_DIR%"
) else (
    call :cleanup_download "%ARCHIVE_PATH%" "%TEMP_DIR%"
)

"%BUN_EXE%" --version >nul 2>nul
if errorlevel 1 (
    echo [init-host] Downloaded bun.exe did not pass verification.
    exit /b 1
)

exit /b 0

:cleanup_download
if exist "%~1" del /f /q "%~1" >nul 2>nul
if exist "%~2" rd /s /q "%~2" >nul 2>nul
exit /b 0

:capture_bun_version
set "BUN_VERSION="
for /f "usebackq delims=" %%I in (`"%BUN_EXE%" --version 2^>nul`) do if not defined BUN_VERSION set "BUN_VERSION=%%I"
if not defined BUN_VERSION (
    echo [init-host] Failed to read Bun version from %BUN_EXE%
    exit /b 1
)
exit /b 0

:install_server_deps
echo [init-host] Installing server dependencies...
pushd "%HOST_SERVER_DIR%" >nul
if errorlevel 1 (
    echo [init-host] Failed to enter %HOST_SERVER_DIR%
    exit /b 1
)

"%BUN_EXE%" install
set "INSTALL_ERROR=%ERRORLEVEL%"
popd >nul

if not "%INSTALL_ERROR%"=="0" (
    echo [init-host] Server dependency installation failed.
    exit /b 1
)

set "SERVER_STATUS=installed"
exit /b 0

:install_ui_deps
if not exist "%UI_DIR%\package.json" (
    echo [init-host] WARNING: UI not yet scaffolded
    set "UI_STATUS=skipped (UI not yet scaffolded)"
    exit /b 0
)

echo [init-host] Installing UI dependencies...
pushd "%UI_DIR%" >nul
if errorlevel 1 (
    echo [init-host] Failed to enter %UI_DIR%
    exit /b 1
)

"%BUN_EXE%" install
set "INSTALL_ERROR=%ERRORLEVEL%"
popd >nul

if not "%INSTALL_ERROR%"=="0" (
    echo [init-host] UI dependency installation failed.
    exit /b 1
)

set "UI_STATUS=installed"
exit /b 0

:print_summary
echo [init-host] Summary
echo [init-host] Bun version: %BUN_VERSION% (%BUN_SOURCE%)
echo [init-host] Server deps: %SERVER_STATUS%
echo [init-host] UI deps: %UI_STATUS%
echo [init-host] Host: %HOST_SERVER_DIR%
exit /b 0
