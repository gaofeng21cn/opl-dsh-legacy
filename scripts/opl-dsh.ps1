param(
  [ValidateRange(0, 86400)]
  [int]$TimeoutSeconds = 600,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TaskArguments
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $repoRoot 'apps\desktop\.desktop-build\targets\win-x64\runtime\node\node.exe'
$cli = Join-Path $repoRoot 'apps\cli\lib\bin.js'
$patch = Join-Path $repoRoot 'apps\cli\config\opl-headless.cordis.patch.yml'
$defaultHome = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\dsh-home'
$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_OPL_HOME)) { $defaultHome } else { $env:DSH_OPL_HOME }
$profileManifest = Join-Path $dshHome 'profiles\opl-headless\package.json'

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw "OPL DSH runtime Node is missing: $node"
}
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "OPL DSH CLI is not built: $cli"
}
if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) {
  throw "OPL headless profile patch is missing: $patch"
}

$env:DSH_HOME = $dshHome
$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null

$arguments = @(
  $cli
  '--profile'
  'opl-headless'
) + $(if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
  @('--from-default-profile', 'headless')
} else {
  @()
}) + @('--patch', $patch, '--json') + $TaskArguments

$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory (Get-Location).Path `
  -NoNewWindow -PassThru
$completed = $TimeoutSeconds -eq 0 -or $process.WaitForExit($TimeoutSeconds * 1000)
if (-not $completed) {
  $killer = Start-Process -FilePath taskkill.exe -ArgumentList @('/PID', $process.Id, '/T', '/F') `
    -NoNewWindow -Wait -PassThru
  if ($killer.ExitCode -ne 0) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  throw "OPL DSH task exceeded the $TimeoutSeconds second timeout"
}
$process.WaitForExit()
$exitCode = $process.ExitCode
exit $exitCode
