import os from 'node:os';
import path from 'node:path';

/**
 * fish 实际读取的 config 路径。优先 `$XDG_CONFIG_HOME/fish/config.fish`，
 * 未设时才是 `~/.config/fish/config.fish`。写死 ~/.config 会让设了 XDG 的用户
 * PATH 块写到 fish 不读的文件里。
 */
export function fishConfigPath(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? '').trim();
  const base = xdg || path.join(os.homedir(), '.config');
  return path.join(base, 'fish', 'config.fish');
}

/** $SHELL → rc 文件。返回 null 表示无法自动判断（打印手动配置片段） */
export function detectRcFile(platform: 'mac' | 'linux' | 'windows'): string | null {
  if (platform === 'windows') return null;
  const shell = process.env.SHELL ?? '';
  const base = path.basename(shell);
  const home = os.homedir();
  if (base === 'zsh' || base === '-zsh') return path.join(home, '.zshrc');
  if (base === 'bash' || base === '-bash') {
    // macOS Terminal 默认 login shell 读 .bash_profile；Linux 交互 shell 读 .bashrc
    return platform === 'mac' ? path.join(home, '.bash_profile') : path.join(home, '.bashrc');
  }
  // fish 语法不同，不能写 bash 块；由 use.ts 走 fishConfigPath + rcBlockFish
  if (base === 'fish') return null;
  return null;
}

/** 写入时可能被用到的全部 rc 候选（含 fish）。卸载清理用：use 时按 $SHELL 写入，
 *  用户此后换默认 shell（或从 $SHELL 不同的终端跑卸载）时，只清 detectRcFile 指到
 *  的那一个会漏——标记块指向已删除的 current 链接，永久残留在另一个 rc 里。 */
export function rcCandidates(platform: 'mac' | 'linux' | 'windows'): string[] {
  if (platform === 'windows') return [];
  const home = os.homedir();
  // fish：当前 XDG 路径 + 默认 ~/.config（用户改过 XDG_CONFIG_HOME 时两边都可能有块）
  const fishPaths = [...new Set([fishConfigPath(), path.join(home, '.config', 'fish', 'config.fish')])];
  return [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
    ...fishPaths,
  ];
}
