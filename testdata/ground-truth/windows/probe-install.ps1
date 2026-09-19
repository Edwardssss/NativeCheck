# Windows ground-truth probe (native, no Docker)
#
# The Linux harness (testdata/ground-truth/run-matrix.sh) runs each fixture in a
# container and wraps cc/gcc on PATH to see whether a compile really happened.
# Windows cannot reuse that path, so this script produces the same kind of
# evidence natively:
#
#   1. install the fixture in a throwaway directory with `npm ci` (real network,
#      real lockfile), inside the MSVC developer environment;
#   2. record whether a compiler was actually invoked (PATH shim) and whether
#      build intermediates / .node binaries were produced;
#   3. record what the tool *predicted* for the same fixture (prediction.json);
#   4. emit one result.json per cell plus a summary, so `collect.py --windows`
#      can print the L2 four-square table.
#
# Usage:
#   powershell -File testdata/ground-truth/windows/probe-install.ps1 \
#     -Cells esbuild-style,sharp-style -OutRoot .tmp/win-gt -TimeoutSec 300

[CmdletBinding()]
param(
  [string[]] $Cells = @(),
  [string] $OutRoot = '',
  [int] $TimeoutSec = 300,
  [string] $RepoRoot = ''
)

# Deliberately *not* 'Stop': native commands (npm, node) write warnings to
# stderr, and with 'Stop' PowerShell turns those into terminating errors, which
# would abort a measurement over a deprecation notice. Failures are checked
# explicitly via exit codes instead.
$ErrorActionPreference = 'Continue'
$script:repoRoot = if ($RepoRoot) {
  (Resolve-Path $RepoRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
}
$script:outRoot = if ($OutRoot) {
  $OutRoot
} else {
  Join-Path $script:repoRoot '.tmp\win-ground-truth'
}

# --- the sample set ---------------------------------------------------------
# Deliberately small and hand-picked: each entry is one distribution pattern, so
# the table shows whether the *pattern* was right, not just whether some package
# compiled. Sample size is the honest weakness of this measurement and the
# README says so.
$allCells = @(
  [pscustomobject]@{ name = 'a-esbuild'; dir = 'fixtures\pattern-a-platform-optional-deps\esbuild-style'; pkg = 'esbuild'; expect = 'A/PREBUILT' },
  [pscustomobject]@{ name = 'a-sharp'; dir = 'fixtures\pattern-a-platform-optional-deps\sharp-style'; pkg = 'sharp'; expect = 'A/PREBUILT' },
  [pscustomobject]@{ name = 'b-better-sqlite3'; dir = 'fixtures\pattern-b-prebuildify\all-platforms'; pkg = 'better-sqlite3'; expect = 'B/PREBUILDIFY' },
  [pscustomobject]@{ name = 'c-bcrypt'; dir = 'fixtures\pattern-c-remote-download\bcrypt-node-pre-gyp'; pkg = 'bcrypt'; expect = 'C/REMOTE' },
  [pscustomobject]@{ name = 'd-bignum'; dir = 'fixtures\pattern-d-source-only\bignum'; pkg = 'bignum'; expect = 'D/SOURCE' },
  [pscustomobject]@{ name = 'd-sleep'; dir = 'fixtures\pattern-d-source-only\nan-sleep'; pkg = 'sleep'; expect = 'D/SOURCE' }
)

if ($Cells.Count -gt 0) {
  # `-File script.ps1 -Cells a,b` hands over one comma-joined string rather than
  # an array, so split it here instead of making callers learn -Command.
  $wanted = @($Cells | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
  $allCells = $allCells | Where-Object { $wanted -contains $_.name }
}
if (-not $allCells) { throw "no cells matched: $($Cells -join ',')" }

# --- locate the MSVC developer environment ---------------------------------
# Required for the *install* side: node-gyp resolves the toolchain absolutely, so
# this is not something a PATH shim can substitute for.
function Get-VcVarsScript {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $null }
  $install = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath 2>$null
  if (-not $install) { return $null }
  $script = Join-Path $install.Trim() 'VC\Auxiliary\Build\vcvars64.bat'
  if (Test-Path $script) { return $script }
  return $null
}

$vcvars = Get-VcVarsScript
if (-not $vcvars) {
  Write-Warning 'no MSVC developer environment found; source-build cells will fail for environment reasons, not tool reasons'
}

# --- the compiler shim -----------------------------------------------------
# Records every cl.exe / link.exe invocation, then delegates to the real one.
# On Windows this may never fire (gyp uses absolute MSVC paths rather than PATH),
# which is itself recorded: an empty log next to produced .obj files means
# "compiled, but the shim could not see it".
function New-ShimDir([string] $dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($tool in @('cl', 'link')) {
    $real = (& where.exe "$tool.exe" 2>$null | Where-Object { $_ -notlike "$dir*" } | Select-Object -First 1)
    if (-not $real) { continue }
    $body = @"
@echo off
echo %TIME% $tool %* >> "%NC_COMPILER_LOG%"
"$real" %*
exit /b %ERRORLEVEL%
"@
    Set-Content -Path (Join-Path $dir "$tool.cmd") -Value $body -Encoding ASCII
  }
}

# --- measurement -----------------------------------------------------------
function Get-BuildEvidence([string] $nodeModules) {
  $nodeBinaries = @()
  $prebuiltBinaries = @()
  $intermediates = @()
  $gypConfigs = @()
  $platformPackages = @()
  if (-not (Test-Path $nodeModules)) {
    return [pscustomobject]@{
      nodeBinaries = $nodeBinaries; prebuiltBinaries = $prebuiltBinaries; intermediates = $intermediates
      gypConfigs = $gypConfigs; platformPackages = $platformPackages
    }
  }
  # A `.node` under a `prebuilds\` directory is a binary that shipped in the
  # tarball (prebuildify); one anywhere else is the product of a local build.
  # Keeping them apart is what makes "no compile happened" checkable rather than
  # merely asserted.
  $allNodes = @(Get-ChildItem -Path $nodeModules -Recurse -Filter '*.node' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName.Substring($nodeModules.Length).TrimStart('\') })
  $nodeBinaries = @($allNodes | Select-Object -First 20)
  $prebuiltBinaries = @($allNodes | Where-Object { $_ -match '\\prebuilds\\' })
  # Object/lib files are the footprint of a compiler having actually run.
  $intermediates = @(Get-ChildItem -Path $nodeModules -Recurse -Include '*.obj', '*.o', '*.lib', '*.pdb' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName.Substring($nodeModules.Length).TrimStart('\') } |
      Select-Object -First 40)
  $gypConfigs = @(Get-ChildItem -Path $nodeModules -Recurse -Filter 'config.gypi' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName.Substring($nodeModules.Length).TrimStart('\') })
  # For Pattern A the positive evidence is the platform sub-package being
  # installed at all (esbuild ships a Go binary, so there is no .node to count).
  # The trailing `(-|$)` matters: `@esbuild/win32-x64` ends with the triple, while
  # `@img/sharp-libvips-win32-x64` has more after the vendor segment.
  $platformPackages = @(Get-ChildItem -Path $nodeModules -Recurse -Directory -Depth 2 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '(^|-)(win32|linux|darwin|android|freebsd)(-|$)' } |
      ForEach-Object { $_.FullName.Substring($nodeModules.Length).TrimStart('\') })
  return [pscustomobject]@{
    nodeBinaries = $nodeBinaries; prebuiltBinaries = $prebuiltBinaries; intermediates = $intermediates
    gypConfigs = $gypConfigs; platformPackages = $platformPackages
  }
}

function Invoke-Cell($cell) {
  $fixture = Join-Path $script:repoRoot $cell.dir
  $cellOut = Join-Path $script:outRoot $cell.name
  if (Test-Path $cellOut) { Remove-Item -Recurse -Force $cellOut }
  New-Item -ItemType Directory -Force -Path $cellOut | Out-Null

  $work = Join-Path $cellOut 'work'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Copy-Item (Join-Path $fixture 'package.json') $work
  if (Test-Path (Join-Path $fixture 'package-lock.json')) {
    Copy-Item (Join-Path $fixture 'package-lock.json') $work
  }

  $shimDir = Join-Path $cellOut 'shim'
  New-ShimDir $shimDir
  $compilerLog = Join-Path $cellOut 'compiler.log'
  Set-Content -Path $compilerLog -Value '' -Encoding ASCII

  $launcher = Join-Path $cellOut 'run-cell.cmd'
  $lines = @('@echo off')
  if ($vcvars) { $lines += "call `"$vcvars`" >nul 2>&1" }
  $lines += "set `"PATH=$shimDir;%PATH%`""
  $lines += "set `"NC_COMPILER_LOG=$compilerLog`""
  $lines += "cd /d `"$work`""
  # Two things that are easy to get wrong here:
  #  - `call` is mandatory: invoking npm.cmd directly would transfer control and
  #    end this batch file, so the exit code would never be recorded;
  #  - `--dangerously-allow-all-scripts` is what makes this a measurement of the
  #    *package*, not of npm's script policy. This npm (11.19) warns about
  #    unapproved install scripts; a D-pattern package would then never compile
  #    and the table would show false positives that belong to npm, not to us.
  $lines += 'call npm ci --no-audit --no-fund --loglevel=http --dangerously-allow-all-scripts'
  $lines += 'echo NC_EXIT=%ERRORLEVEL%'
  Set-Content -Path $launcher -Value $lines -Encoding ASCII

  $installLog = Join-Path $cellOut 'install.log'
  $started = Get-Date
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$launcher`"" `
    -RedirectStandardOutput $installLog -RedirectStandardError "$installLog.err" -PassThru -WindowStyle Hidden
  $timedOut = -not $proc.WaitForExit($TimeoutSec * 1000)
  if ($timedOut) { try { $proc.Kill() } catch { } }
  $durationMs = [int]((Get-Date) - $started).TotalMilliseconds

  $logText = ''
  foreach ($f in @($installLog, "$installLog.err")) {
    if (Test-Path $f) { $logText += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
  }
  $exitMatch = [regex]::Match($logText, 'NC_EXIT=(\d+)')
  $installExit = if ($timedOut) { 'timeout' } elseif ($exitMatch.Success) { [int]$exitMatch.Groups[1].Value } else { 'unknown' }

  $evidence = Get-BuildEvidence (Join-Path $work 'node_modules')
  $shimHits = @(Get-Content $compilerLog -ErrorAction SilentlyContinue | Where-Object { $_ -match '\S' })
  # A compiler invocation is a shim hit OR object files on disk: the shim is the
  # stronger signal, the intermediates the fallback when gyp bypassed PATH.
  $compiled = ($shimHits.Count -gt 0) -or ($evidence.intermediates.Count -gt 0)
  # "Compiled" and "tried to compile" are different facts, and the failing
  # legacy packages are exactly the case where only the second is observable:
  # node-gyp runs, the build dies on a Compiler error, nothing is left on disk.
  $buildAttempted = [bool]($logText -match '(?i)(node-gyp|gyp info|MSBuild|\.vcxproj|cl\.exe)')

  # --- what the tool predicted for the same fixture -------------------------
  # Projected by Node, not parsed here: PowerShell 5.1 would decode the CLI's
  # stdout with the console code page and break on the non-ASCII evidence text.
  $projection = & node (Join-Path $PSScriptRoot 'predict.mjs') $fixture $cell.pkg 2>$null
  Set-Content -Path (Join-Path $cellOut 'prediction.json') -Value $projection -Encoding ASCII
  $prediction = $null
  try {
    $prediction = $projection | ConvertFrom-Json
  } catch {
    $prediction = $null
  }

  $result = [pscustomobject]@{
    cell             = $cell.name
    package          = $cell.pkg
    expected         = $cell.expect
    installExit      = $installExit
    timedOut         = [bool]$timedOut
    durationMs       = $durationMs
    compiled         = [bool]$compiled
    buildAttempted   = $buildAttempted
    shimHits         = $shimHits.Count
    nodeBinaries     = $evidence.nodeBinaries.Count
    prebuiltBinaries = $evidence.prebuiltBinaries.Count
    intermediates    = $evidence.intermediates.Count
    gypRan           = ($evidence.gypConfigs.Count -gt 0)
    platformPackages = @($evidence.platformPackages)
    prediction       = $prediction
    vcvars           = $vcvars
    # Kept in the per-cell result so a surprising row can be explained from the
    # record itself, without re-running the install.
    logTail          = @($logText -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 12)
  }
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $cellOut 'result.json') -Encoding UTF8
  return $result
}

New-Item -ItemType Directory -Force -Path $script:outRoot | Out-Null
$results = @()
foreach ($cell in $allCells) {
  Write-Host "== $($cell.name) ($($cell.pkg))" -ForegroundColor Cyan
  $results += Invoke-Cell $cell
}

$results | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $script:outRoot 'summary.json') -Encoding UTF8

Write-Host ''
Write-Host 'cell                  pkg                install  tried  compiled  shim  .node  pre  obj  plat  predicted                          expected' -ForegroundColor Yellow
foreach ($r in $results) {
  $pred = if ($r.prediction -and -not $r.prediction.error) {
    "$($r.prediction.pattern)/$($r.prediction.risk)/$($r.prediction.strategy)"
  } elseif ($r.prediction.error) { '(error)' } else { '(no finding)' }
  Write-Host ("{0,-21} {1,-18} {2,-8} {3,-6} {4,-9} {5,-5} {6,-6} {7,-4} {8,-4} {9,-5} {10,-34} {11}" -f `
      $r.cell, $r.package, $r.installExit, $r.buildAttempted, $r.compiled, $r.shimHits, $r.nodeBinaries, `
      $r.prebuiltBinaries, $r.intermediates, $r.platformPackages.Count, $pred, $r.expected)
}
Write-Host ''
Write-Host "results: $script:outRoot"