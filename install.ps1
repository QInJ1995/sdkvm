# Install sdkvm without a pre-existing Node.js.
# Usage: irm https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.ps1 | iex
# Requires a published GitHub Release with sdkvm.tgz and SHA256SUMS.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.x 的 IWR 进度条会拖慢下载一个数量级
# PS 5.1 默认协议可能不含 TLS 1.2（GitHub 下载需要）
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RuntimeNode = if ($env:SDKVM_RUNTIME_NODE) { $env:SDKVM_RUNTIME_NODE } else { '22.20.0' }
$NodeDist = if ($env:SDKVM_NODE_DIST) { $env:SDKVM_NODE_DIST.TrimEnd('/') } else { 'https://nodejs.org/dist' }
$ReleaseBase = if ($env:SDKVM_RELEASE_BASE) { $env:SDKVM_RELEASE_BASE.TrimEnd('/') } else { 'https://github.com/QInJ1995/sdkvm/releases' }
$Root = if ($env:SDKVM_HOME) { $env:SDKVM_HOME } else { Join-Path $env:USERPROFILE '.sdkvm' }
$BinDir = Join-Path $Root 'bin'
# ROOT 会被内插进 cmd.exe shim（set "ROOT=..."）——含 cmd 元字符或控制字符时无法安全嵌入
if ($Root -match '["%&^\x00-\x1f]') {
  throw "sdkvm: SDKVM_HOME cannot contain \`", %, &, ^ or control characters: $Root"
}

# Prefer the machine arch under WOW64 (32-bit PowerShell on 64-bit Windows)
$procArch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $procArch = $env:PROCESSOR_ARCHITEW6432 }
if ($procArch -eq 'ARM64') {
  $arch = 'arm64'
} elseif ($procArch -eq 'AMD64') {
  $arch = 'x64'
} else {
  throw "sdkvm: unsupported architecture $procArch"
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw 'sdkvm: tar is required to extract archives (bundled with Windows 10 1803+)'
}

$nodeName = "node-v$RuntimeNode-win-$arch"
$nodeArchive = "$nodeName.zip"
$tmpdir = Join-Path ([System.IO.Path]::GetTempPath()) ("sdkvm-install-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmpdir | Out-Null

function Get-FileSha256([string]$path) {
  (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
}

# IWR 瞬时失败（TLS 握手抖动、CDN 503）重试两次；$ErrorActionPreference 对原生退出码无效，但对 cmdlet 抛错有效
function Get-Url([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
      return
    } catch {
      if ($i -eq 3) { throw }
      Start-Sleep -Seconds (2 * $i)
    }
  }
}

function Get-ExpectedHash([string]$sumsPath, [string]$fileName) {
  foreach ($line in Get-Content -Path $sumsPath) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $fileName) {
      return $Matches[1].ToLowerInvariant()
    }
  }
  return $null
}

# Remove a directory junction without following into the target (PS 5.x Remove-Item risk).
# .NET 非递归删除对 reparse point 只摘链接本身、不进目标内容；也不再经 cmd.exe，
# 路径里不需要转义任何 cmd 元字符。
function Remove-Junction([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  [System.IO.Directory]::Delete($path)
  if (Test-Path -LiteralPath $path) {
    throw "sdkvm: failed to remove junction $path"
  }
}

try {
  Write-Host "sdkvm: downloading Node.js $RuntimeNode (windows/$arch)"
  Get-Url "$NodeDist/v$RuntimeNode/$nodeArchive" (Join-Path $tmpdir $nodeArchive)
  Get-Url "$NodeDist/v$RuntimeNode/SHASUMS256.txt" (Join-Path $tmpdir 'SHASUMS256.txt')
  $expected = Get-ExpectedHash (Join-Path $tmpdir 'SHASUMS256.txt') $nodeArchive
  $actual = Get-FileSha256 (Join-Path $tmpdir $nodeArchive)
  if (-not $expected -or $expected -ne $actual) { throw 'sdkvm: Node.js checksum mismatch' }

  Write-Host 'sdkvm: downloading CLI'
  try {
    Get-Url "$ReleaseBase/latest/download/sdkvm.tgz" (Join-Path $tmpdir 'sdkvm.tgz')
    Get-Url "$ReleaseBase/latest/download/SHA256SUMS" (Join-Path $tmpdir 'SHA256SUMS')
  } catch {
    throw "sdkvm: download failed ($ReleaseBase/latest/download/sdkvm.tgz). Publish a GitHub Release (push a v* tag) with sdkvm.tgz, or install via: npm install -g sdkvm"
  }
  $expected = Get-ExpectedHash (Join-Path $tmpdir 'SHA256SUMS') 'sdkvm.tgz'
  $actual = Get-FileSha256 (Join-Path $tmpdir 'sdkvm.tgz')
  if (-not $expected -or $expected -ne $actual) { throw 'sdkvm: CLI checksum mismatch' }

  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime'), $BinDir | Out-Null
  $runtimeDir = Join-Path $Root 'runtime'
  if (Test-Path (Join-Path $runtimeDir $nodeName)) { Remove-Item -Recurse -Force (Join-Path $runtimeDir $nodeName) }
  # PS 5.1 里原生命令非零退出不触发 $ErrorActionPreference，必须显式查 $LASTEXITCODE
  tar -xf (Join-Path $tmpdir $nodeArchive) -C $runtimeDir
  if ($LASTEXITCODE -ne 0) { throw "sdkvm: failed to extract the Node.js archive (tar exit $LASTEXITCODE)" }
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir $nodeName))) { throw "sdkvm: Node.js archive did not extract $nodeName" }
  $current = Join-Path $runtimeDir 'current'
  # current 若是真实目录（非 junction）可能是用户自己放的内容，不能当链接摘除
  if ((Test-Path -LiteralPath $current) -and -not ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "sdkvm: $current exists and is not a junction; move it away and retry"
  }
  Remove-Junction $current
  New-Item -ItemType Junction -Path $current -Target (Join-Path $runtimeDir $nodeName) | Out-Null

  # Atomic CLI replace: extract + validate, then rename; restore bak on failure
  $staging = Join-Path $Root 'cli.next'
  $bak = Join-Path $Root 'cli.bak'
  $cli = Join-Path $Root 'cli'
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  if (Test-Path $bak) { Remove-Item -Recurse -Force $bak }
  New-Item -ItemType Directory -Path $staging | Out-Null
  tar -xf (Join-Path $tmpdir 'sdkvm.tgz') -C $staging
  if ($LASTEXITCODE -ne 0) { throw "sdkvm: failed to extract the CLI archive (tar exit $LASTEXITCODE)" }
  $unpacked = Join-Path $staging 'package'
  if (-not (Test-Path (Join-Path $unpacked 'package.json'))) {
    Remove-Item -Recurse -Force $staging
    throw 'sdkvm: release archive missing package/package.json'
  }
  if (Test-Path $cli) { Move-Item $cli $bak }
  try {
    Move-Item $unpacked $cli
  } catch {
    if ((Test-Path $bak) -and -not (Test-Path $cli)) { Move-Item $bak $cli }
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    throw
  }
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  if (Test-Path $bak) { Remove-Item -Recurse -Force $bak }

  # shim 运行时用 %~dp0 推导根路径，不内嵌安装路径：非 ASCII 用户名不会被 ascii 编码损坏
  @"
@echo off
if defined SDKVM_HOME (
  set "ROOT=%SDKVM_HOME%"
) else (
  for %%i in ("%~dp0..") do set "ROOT=%%~fi"
)
"%ROOT%\runtime\current\node.exe" "%ROOT%\cli\dist\index.js" %*
"@ | Set-Content -Encoding ascii (Join-Path $BinDir 'sdkvm.cmd')

  Write-Host "sdkvm: installed to $BinDir\sdkvm.cmd"
  Write-Host "sdkvm: runtime $current (isolated from sdkvm node use)"

  # 写入用户 PATH（幂等）；优先用 %USERPROFILE%\.sdkvm\bin 形式
  $home = [Environment]::GetFolderPath('UserProfile')
  if ($BinDir.StartsWith($home, [StringComparison]::OrdinalIgnoreCase)) {
    $pathEntry = '%USERPROFILE%' + $BinDir.Substring($home.Length)
  } else {
    $pathEntry = $BinDir
  }
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $fmt = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $raw = [string]$k.GetValue('Path', '', $fmt)
  $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
  $norm = {
    param($p)
    $p.TrimEnd('\').ToLowerInvariant()
  }
  $already = $false
  foreach ($p in $parts) {
    if ((& $norm $p) -eq (& $norm $pathEntry) -or ((& $norm $p) -eq (& $norm $BinDir))) {
      $already = $true
      break
    }
  }
  if (-not $already) {
    $parts = @($pathEntry) + $parts
    # 写入值含 %USERPROFILE% 引用 → 恒用 REG_EXPAND_SZ：REG_SZ 里的 %VAR% 永不展开，
    # 该条目会成为死 PATH；升级为 REG_EXPAND_SZ 对无 % 的既有条目无影响
    $k.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Write-Host "sdkvm: added $pathEntry to user PATH (reopen the terminal)"
  }
  $k.Close()

  # 广播 WM_SETTINGCHANGE，让已打开的 Explorer / 终端感知新的用户 PATH
  $sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
  $native = Add-Type -MemberDefinition $sig -Name 'NativeMethods' -Namespace 'sdkvm' -PassThru
  $r = [UIntPtr]::Zero
  $null = $native::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
} finally {
  Remove-Item -Recurse -Force $tmpdir -ErrorAction SilentlyContinue
}
