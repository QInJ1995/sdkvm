import os from 'node:os';
import path from 'node:path';

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
  if (base === 'fish') return null; // fish 语法不同，打印手动片段
  return null;
}

/** 写入时可能被用到的全部 rc 候选（含 fish）。卸载清理用：use 时按 $SHELL 写入，
 *  用户此后换默认 shell（或从 $SHELL 不同的终端跑卸载）时，只清 detectRcFile 指到
 *  的那一个会漏——标记块指向已删除的 current 链接，永久残留在另一个 rc 里。 */
export function rcCandidates(platform: 'mac' | 'linux' | 'windows'): string[] {
  if (platform === 'windows') return [];
  const home = os.homedir();
  return [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
    path.join(home, '.config', 'fish', 'config.fish'),
  ];
}
