# Install a packaged OPL DSH application on Windows.
#
# This is the Windows counterpart of opl/install-macos.sh. macOS installs by
# copying the bundle into /Applications and then re-verifying the code
# signature, because a `ditto` merge would leave resources the signature does
# not cover. Windows has no sealed bundle, so the same guarantees are obtained
# differently: the artifact is checked before anything runs, the installer is
# used when one was built, and what lands on disk is re-checked against the OPL
# package guard instead of a signature.
#
# The previous installation is never destroyed before the new one is verified.
# It is moved aside first and only removed once the check passes, so a failed
# install leaves a working application behind.
#
# Usage (from the repository root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/opl/install-windows.ps1
#   ... -Unpacked                      # copy the unpacked tree instead of running the installer
#   ... -Source <path-to-exe-or-dir>   # install a specific build
param(
  [string]$Source,
  [switch]$Unpacked,
  [switch]$KeepPrevious
)

$ErrorActionPreference = 'Stop'

$oplRoot = $PSScriptRoot
$desktopRoot = Split-Path $oplRoot -Parent
$targetRoot = Join-Path $desktopRoot '.desktop-build/targets/win-x64'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs/OPL DSH'
$previousRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'opl-dsh-previous'
$launcherName = 'OPL DSH.exe'

# PowerShell's own string comparison is ordinal, so a user typing the extension
# in upper case would otherwise fall through to the directory branch.
function Test-InstallerPath {
  param([string]$Path)
  return $Path.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-BuildSource {
  param([string]$Requested)
  if ($Requested) {
    if (-not (Test-Path -LiteralPath $Requested)) { throw "install-windows: no such build: $Requested" }
    return $Requested
  }
  if (-not (Test-Path -LiteralPath $targetRoot)) {
    throw "install-windows: package the application first:`n  pnpm --dir apps/desktop run package:opl:win:x64:unsigned"
  }
  # A completed installer is preferred; the unpacked tree is the fallback so a
  # `--dir` build can still be installed and launched. electron-builder places
  # that tree inside the output directory it was given, so both the unsigned and
  # the release output roots are searched rather than one being assumed.
  foreach ($root in @('unsigned-artifacts', 'artifacts')) {
    $candidate = Join-Path $targetRoot $root
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $setup = Get-ChildItem -LiteralPath $candidate -Filter 'opl-dsh-*-win-x64-setup.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($setup) { return $setup.FullName }
  }
  $unpacked = Get-ChildItem -LiteralPath $targetRoot -Directory -Filter 'win-unpacked' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($unpacked) { Write-Output 'install-windows: no installer found; using the unpacked tree'; return $unpacked.FullName }
  throw "install-windows: no installer or unpacked tree under $targetRoot"
}

function Invoke-Verification {
  param([string]$Candidate)
  $node = if ($env:DSH_DESKTOP_NODE_BINARY) { $env:DSH_DESKTOP_NODE_BINARY } else { 'node' }
  $stdout = Join-Path ([System.IO.Path]::GetTempPath()) "opl-dsh-verify-$([Guid]::NewGuid().ToString('N')).out"
  $stderr = Join-Path ([System.IO.Path]::GetTempPath()) "opl-dsh-verify-$([Guid]::NewGuid().ToString('N')).err"
  $verifier = Join-Path $oplRoot 'verify-opl-package.mjs'
  try {
    # Start-Process preserves the exit code and captures output for bundled
    # Windows runtimes whose console streams are not inherited by PowerShell.
    $arguments = @("`"$verifier`"", "`"$Candidate`"")
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $oplRoot `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru
    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout | Write-Output }
    if ($process.ExitCode -ne 0) {
      $details = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Raw).Trim() } else { '' }
      if ($details) { Write-Error $details }
      throw "install-windows: package verification failed for $Candidate (exit $($process.ExitCode))"
    }
  }
  finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

# An NSIS silent install returns before the application directory is complete,
# so the launcher is waited for rather than assumed.
function Wait-ForInstallation {
  param([int]$TimeoutSeconds = 300)
  $launcher = Join-Path $installRoot $launcherName
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $launcher) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "install-windows: the installer left no application at $installRoot within ${TimeoutSeconds}s"
}

$source = Resolve-BuildSource -Requested $Source
$isInstaller = Test-InstallerPath -Path $source
if ($Unpacked -and $isInstaller) { throw 'install-windows: -Unpacked requires an unpacked directory, not an installer' }

# An installer is verified on its own bytes and again through the tree it
# produced; a directory build is verified in place. Every route ends in the same
# guard, so a broken package cannot be presented as an installation.
if ($isInstaller) {
  Invoke-Verification -Candidate $source
  Write-Output "install-windows: running $source /S"
  # NSIS is configured per-user, so this needs no elevation and no `RunAs`.
  $process = Start-Process -FilePath $source -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "install-windows: the installer exited with $($process.ExitCode)" }
  Wait-ForInstallation
  Invoke-Verification -Candidate $installRoot
  Write-Output "install-windows: installed and verified $installRoot"
  Write-Output 'install-windows: this build is unsigned; Windows SmartScreen may warn on first launch.'
  return
}

if (-not (Test-Path -LiteralPath (Join-Path $source 'resources'))) {
  throw "install-windows: $source is not an unpacked OPL DSH application directory"
}
Invoke-Verification -Candidate $source

if (Test-Path -LiteralPath $previousRoot) { Remove-Item -LiteralPath $previousRoot -Recurse -Force }
$hadPrevious = Test-Path -LiteralPath $installRoot
if ($hadPrevious) { Move-Item -LiteralPath $installRoot -Destination $previousRoot }

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
# Enumerating first keeps the copy independent of wildcard expansion, so a build
# path containing `[` or `]` — legal on Windows — still installs.
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $installRoot -Recurse -Force

try {
  Invoke-Verification -Candidate $installRoot
}
catch {
  if ($hadPrevious) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $previousRoot -Destination $installRoot
    throw 'install-windows: the new installation failed verification and was rolled back to the previous build'
  }
  Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw 'install-windows: the new installation failed verification and was removed'
}

if ($KeepPrevious) {
  Write-Output "install-windows: installed and verified $installRoot; the previous build stays at $previousRoot"
}
else {
  if ($hadPrevious) { Remove-Item -LiteralPath $previousRoot -Recurse -Force }
  Write-Output "install-windows: installed and verified $installRoot"
}
Write-Output 'install-windows: this build is unsigned; Windows SmartScreen may warn on first launch.'
