const WIDTH = 26;

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

/** TTY 进度刷新间隔。每个分块都写 stderr 会在大归档上下拖慢下载循环。 */
const TTY_INTERVAL_MS = 100;

/** stderr 单行进度条；TTY 约每 100ms 刷新一次，非 TTY 降级为每 16MB 打一行 */
export function createProgress(label: string) {
  const isTty = process.stderr.isTTY === true;
  let lastLine = 0;
  let lastDraw = 0;

  return {
    update(bytes: number, total: number | null): void {
      if (isTty) {
        const now = Date.now();
        if (now - lastDraw < TTY_INTERVAL_MS) return;
        lastDraw = now;
        const ratio = total ? Math.min(1, bytes / total) : null;
        const bar =
          ratio === null
            ? humanBytes(bytes)
            : `${'█'.repeat(Math.round(ratio * WIDTH))}${'░'.repeat(WIDTH - Math.round(ratio * WIDTH))} ${(ratio * 100).toFixed(1)}%`;
        process.stderr.write(`\r${label} ${bar}`.padEnd(72));
      } else if (bytes - lastLine >= 16 * 1024 * 1024) {
        lastLine = bytes;
        process.stderr.write(`${label} ${humanBytes(bytes)}${total ? ` / ${humanBytes(total)}` : ''}\n`);
      }
    },
    done(bytes: number, total: number | null): void {
      if (isTty) {
        process.stderr.write(`\r${label} ${humanBytes(bytes)}${total ? ` / ${humanBytes(total)}` : ''} ✓\n`);
      } else if (bytes - lastLine >= 0) {
        process.stderr.write(`${label} ${humanBytes(bytes)} complete\n`);
      }
    },
  };
}
