import os from 'node:os';
import path from 'node:path';
import { run } from '../util/spawn.js';
import { paths } from '../core/paths.js';
import { detectPlatform } from '../core/platform.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';

/** PowerShell 脚本用 EncodedCommand 传递，避免引号转义问题 */
function encoded(ps: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
}

/** 当前链接：默认相对 %USERPROFILE%；SDKVM_HOME 在 home 外时写绝对路径 */
function currentLinkWin(type: SdkTypeId): string {
  const abs = paths.current(type);
  const rel = path.relative(os.homedir(), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return abs;
  }
  return `%USERPROFILE%\\${rel.split(path.sep).join('\\')}`;
}

/** WM_SETTINGCHANGE 广播，让 Explorer 等读取新环境变量 */
function broadcastPs(): string[] {
  return [
    "$sig='[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    'Add-Type -MemberDefinition $sig -Name NativeMethods -Namespace Win32',
    '$r=[UIntPtr]::Zero',
    '[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, \'Environment\', 2, 5000, [ref]$r) | Out-Null',
  ];
}

/**
 * REG_EXPAND_SZ 会展开值里每一个 %NAME%。
 * 只保留前导的 %VAR%（%USERPROFILE%、%JAVA_HOME% 等），路径其余部分的 % 写成 %%。
 * 没有环境变量引用的绝对路径用 REG_SZ，百分号保持字面量。
 */
export function registryEnvValue(value: string): { data: string; expand: boolean } {
  const lead = /^%([A-Za-z_][A-Za-z0-9_]*)%(.*)$/.exec(value);
  if (!lead?.[1]) return { data: value, expand: false };
  return { data: `%${lead[1]}%${(lead[2] ?? '').replace(/%/g, '%%')}`, expand: true };
}

/** 写用户级环境变量并广播。含 %VAR% 时用 REG_EXPAND_SZ，否则 REG_SZ。 */
export async function setEnvWin(name: string, value: string): Promise<void> {
  const stored = registryEnvValue(value);
  const escaped = stored.data.replace(/'/g, "''");
  const kind = stored.expand
    ? '[Microsoft.Win32.RegistryValueKind]::ExpandString'
    : '[Microsoft.Win32.RegistryValueKind]::String';
  const ps = [
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
    "if(-not $k){ throw 'no Environment key' }",
    `$k.SetValue('${name.replace(/'/g, "''")}', '${escaped}', ${kind})`,
    ...broadcastPs(),
  ].join('\n');
  await run('powershell.exe', encoded(ps));
}

/** 写该类型的环境变量（JAVA_HOME / GO_HOME / FLUTTER_HOME / NODE_HOME → current 链接） */
export async function setSdkEnvWin(type: SdkTypeId): Promise<void> {
  const spec = getSdkType(type);
  await setEnvWin(spec.envVar, currentLinkWin(type));
}

/**
 * 把指定 entry（如 %JAVA_HOME%\bin）追加到用户 PATH。
 * 关键点：用 DoNotExpandEnvironmentNames 读原始值，保留 %VAR% 引用（.NET SetEnvironmentVariable
 * 会把类型降级为 REG_SZ，破坏 %USERPROFILE% 类引用），最后广播 WM_SETTINGCHANGE。
 * 写入值恒含 %VAR% 引用 → 恒写 REG_EXPAND_SZ：即使原 Path 是 REG_SZ（setx 的典型后果），
 * %JAVA_HOME%\bin 在 REG_SZ 里也永不展开；升级为 REG_EXPAND_SZ 对无 % 的既有条目无影响。
 */
export async function ensureUserPathWin(entry: string): Promise<void> {
  const stored = registryEnvValue(entry).data.replace(/'/g, "''");
  const ps = [
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
    "if(-not $k){ throw 'no Environment key' }",
    "$fmt=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    "$raw=[string]$k.GetValue('Path','',$fmt)",
    "$parts=@($raw -split ';' | Where-Object { $_ -ne '' })",
    // 比较前先 Trim：regedit 等手工编辑过的条目常带首尾空白，精确比较会让
    // 同一条目被判定为"不存在"而重复追加
    `if(@($parts | ForEach-Object { $_.Trim() }) -notcontains '${stored}'){`,
    `  $parts += '${stored}'`,
    "  $k.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    "}",
    ...broadcastPs(),
  ].join('\n');
  await run('powershell.exe', encoded(ps));
}

/** 卸载辅助：从用户 PATH 移除 entry（Path 不存在或不含 entry 时不动注册表）。 */
export async function removeFromUserPathWin(entry: string): Promise<void> {
  const stored = registryEnvValue(entry).data.replace(/'/g, "''");
  const raw = entry.replace(/'/g, "''");
  const ps = [
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
    "if(-not $k){ exit 0 }",
    "$fmt=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    "if($null -eq $k.GetValue('Path', $null)){ exit 0 }",
    "$raw=[string]$k.GetValue('Path','',$fmt)",
    "$parts=@($raw -split ';' | Where-Object { $_ -ne '' })",
    // 不含 entry 时直接退出：重写同样的值再广播 WM_SETTINGCHANGE 没有意义。
    // 比较前先 Trim：regedit 手工编辑过的条目常带首尾空白，精确比较会漏掉
    // 该删的条目，卸载后 PATH 里残留指向已删链接的空引用
    `if(-not ($parts | Where-Object { $_.Trim() -eq '${stored}' -or $_.Trim() -eq '${raw}' })){ exit 0 }`,
    `$parts=@($parts | Where-Object { $_.Trim() -ne '${stored}' -and $_.Trim() -ne '${raw}' })`,
    "$k.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    ...broadcastPs(),
  ].join('\n');
  await run('powershell.exe', encoded(ps));
}

/** 卸载辅助：删除用户级环境变量值（不存在则忽略）并广播 */
export async function removeEnvWin(name: string): Promise<void> {
  const escaped = name.replace(/'/g, "''");
  const ps = [
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
    "if(-not $k){ exit 0 }",
    `if($null -ne $k.GetValue('${escaped}')){ $k.DeleteValue('${escaped}') }`,
    ...broadcastPs(),
  ].join('\n');
  await run('powershell.exe', encoded(ps));
}

/** 只读某用户级环境变量的原始注册表值：不存在或查询失败返回 null（不抛）。
 *  DoNotExpand 保留 %VAR% 引用原样——调用方判断的是"注册表里有没有/是什么"，不是展开结果。
 *  输出编码先切 UTF-8：控制台默认 OEM 代码页会把非 ASCII 值（中文用户名路径等）
 *  输出成乱码，execFile 按 UTF-8 解码后就是替换字符 */
export async function getEnvWin(name: string): Promise<string | null> {
  const escaped = name.replace(/'/g, "''");
  const ps = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
    "if(-not $k){ exit 0 }",
    "$fmt=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    `$v=$k.GetValue('${escaped}', $null, $fmt)`,
    "if($null -eq $v){ exit 0 }",
    "[Console]::Out.Write([string]$v)",
  ].join('\n');
  try {
    const { stdout } = await run('powershell.exe', encoded(ps));
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/** 某类型要写入用户 PATH 的全部项。多数 SDK 只有一段；Miniconda 在 Windows 有多段。 */
export function sdkPathEntries(type: SdkTypeId): string[] {
  const spec = getSdkType(type);
  const platform = detectPlatform();
  const suffixes = spec.envPathSuffixes?.(platform) ?? [spec.envBinSuffix(platform)];
  return suffixes.map((suffix) => `%${spec.envVar}%${suffix}`);
}
