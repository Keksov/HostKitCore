<#
  AP1.2: sync the AppCore launcher binaries (AppMain.exe + libwebview.dll) into
  a host's server folder, next to its app.cfg, so AppMain.exe auto-loads app.cfg and
  launches the host via AppCore.

  GCY2.1 (plan gnauralcity, GCY-D17, GCY-D9): moved here from
  MindWaveCore/server/sync-appcore-launcher.ps1 (now a thin wrapper over this file)
  and generalized: the host's server folder is a PARAMETER, HostKitCore knows no host
  (GCY-D19). Each host brings its own branding there - AppCore.ini (window title) and
  AppCore.ico, which is stamped into the copied AppMain.exe below.

    sync-appcore-launcher.ps1 -ServerDir <host server folder> [-AppCoreBin <path>] [-MissingOnly]

  Binaries are SYNC-ONLY (AP-D7a): they are gitignored in the host; re-run this after
  (re)building AppCore. Default source is the sibling Games/AppCore prebuilt bin.

  -MissingOnly (GCY5.3, plan gnauralcity, GCY-D37 -- what the workspace bootstrap passes for every
  host of hosts.json): copy only the files the host does NOT have yet, keep the present ones as they
  are. A re-run of the bootstrap must not overwrite a launcher put there by hand: on 2026-10-16 both
  hosts carried a libwebview.dll newer than the one in the default AppCore bin, and a plain sync
  would have downgraded it. Without the switch every file is copied, as before.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerDir,
  [string]$AppCoreBin,
  [switch]$MissingOnly
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ServerDir -PathType Container)) {
  throw "host server folder not found: $ServerDir"
}
$ServerDir = (Resolve-Path -LiteralPath $ServerDir).Path
if ($MissingOnly) {
  $missing = @(@('AppMain.exe', 'libwebview.dll') | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ServerDir $_) -PathType Leaf) })
  if ($missing.Count -eq 0) {
    # Nothing to copy: AppCore need not even be on this machine.
    Write-Host "  launcher present in $ServerDir (AppMain.exe, libwebview.dll) - kept as it is (-MissingOnly)"
    exit 0
  }
}
if (-not $AppCoreBin) {
  $AppCoreBin = Join-Path $PSScriptRoot '..\..\..\Games\AppCore\build\win_x64\bin'
}
if (-not (Test-Path -LiteralPath $AppCoreBin)) {
  throw "AppCore bin not found: $AppCoreBin (build AppCore or pass -AppCoreBin <path>)"
}

$copiedExe = $false
foreach ($file in @('AppMain.exe', 'libwebview.dll')) {
  $dst = Join-Path $ServerDir $file
  if ($MissingOnly -and (Test-Path -LiteralPath $dst -PathType Leaf)) {
    Write-Host ("  kept existing {0} (-MissingOnly)" -f $file)
    continue
  }
  $src = Join-Path $AppCoreBin $file
  if (-not (Test-Path -LiteralPath $src)) { throw "missing AppCore artifact: $src" }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  Write-Host ("  synced {0}" -f $file)
  if ($file -eq 'AppMain.exe') { $copiedExe = $true }
}

# The synced bin\AppMain.exe is generic (no embedded icon). Stamp this deployment's
# AppCore.ico into it (overlay-safe) so Explorer / taskbar / pinned shortcuts show the
# right icon - mirrors AppCore build_app.bat's deploy stamping.
$icon    = Join-Path $ServerDir 'AppCore.ico'
$stamper = Join-Path $AppCoreBin 'IconStamp.exe'
$exe     = Join-Path $ServerDir 'AppMain.exe'
if (-not $copiedExe) {
  Write-Host '  (AppMain.exe kept as it was - not re-stamped)'
} elseif ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath $stamper)) {
  & $stamper $exe $icon
  Write-Host '  stamped icon from AppCore.ico'
} else {
  Write-Host '  (no AppCore.ico or IconStamp.exe next to AppCore bin - skipped icon stamping)'
}

Write-Host "Done. Run AppMain.exe in $ServerDir (it auto-loads app.cfg) to launch the host."
