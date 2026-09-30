import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgress } from '../src/ui/progress.js';

describe('createProgress TTY 节流', () => {
  let isTTY: boolean | undefined;
  const writes: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true });
    writes.length = 0;
  });

  it('100ms 内只刷新一次，到点后再刷，结束行始终写出', () => {
    isTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const progress = createProgress('↓ jdk');
    progress.update(1024, 4096);
    progress.update(2048, 4096);
    expect(writes).toHaveLength(1);

    vi.setSystemTime(1_000_100);
    progress.update(3072, 4096);
    expect(writes).toHaveLength(2);

    progress.done(4096, 4096);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain('✓');
  });
});
