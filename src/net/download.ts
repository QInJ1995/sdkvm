import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { httpFetch } from './http.js';
import { SdkvmError } from '../util/errors.js';
import { renameWithRetry } from '../util/rename.js';

export interface DownloadResult {
  file: string;
  sha256: string;
  bytes: number;
  /** 服务端声明的 content-length（压缩传输或缺失时为 null） */
  total: number | null;
}

/** 流式下载到 .part（边下边算 sha256），完成后原子 rename。
 * 超时语义是「空闲」而非总时长：每个 chunk 刷新计时器，避免大归档（Flutter ~2GB）被总时长掐断。 */
const IDLE_TIMEOUT_MS = 60_000;

/** 写盘失败或 destroy 进行中的回调会在 WriteStream 上 emit error。没人听就会变成未处理错误，把进程打崩。 */
function watchWriteStream(out: fs.WriteStream): { error: () => Error | null } {
  let streamError: Error | null = null;
  out.on('error', (err: Error) => {
    streamError ??= err;
  });
  return { error: () => streamError };
}

/**
 * 背压时等 drain。磁盘错误会先 destroy 写流且不再发 drain，只等 drain 会一直挂住。
 */
function waitForDrain(out: fs.WriteStream, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortReason = (): Error =>
      signal.reason instanceof Error ? signal.reason : new Error('aborted');
    if (signal.aborted) {
      reject(abortReason());
      return;
    }
    if (out.destroyed || out.closed) {
      reject(new Error('write stream closed before drain'));
      return;
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      out.off('drain', onDrain);
      out.off('error', onError);
      out.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('write stream closed before drain'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    out.once('drain', onDrain);
    out.once('error', onError);
    out.once('close', onClose);
  });
}

/** 底层 open(2)/close 卡死（NFS/SMB/FIFO）时 'close' 永远不来。
 *  有界等待后强制 destroy 放行，让清理路径（rm .part）能继续。 */
const CLOSE_TIMEOUT_MS = 15_000;

async function closeWriteStream(out: fs.WriteStream): Promise<void> {
  if (out.closed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      out.destroy();
      resolve();
    }, CLOSE_TIMEOUT_MS);
    out.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (!out.destroyed) out.destroy();
  });
}

export async function downloadFile(
  url: string,
  destFile: string,
  onProgress?: (bytes: number, total: number | null) => void,
): Promise<DownloadResult> {
  // .part 带进程号：下载在锁外进行，同 URL 并发下载各写各的临时文件，
  // 完成时各自原子 rename 到 dest（同 URL 内容相同，先后覆盖无害）
  const partFile = `${destFile}.tmp-${process.pid}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partFile);
  const stream = watchWriteStream(out);
  let bytes = 0;
  let total: number | null = null;
  let encoded = false;
  let stalled = false;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    stalled = true;
    ac.abort();
  }, IDLE_TIMEOUT_MS);

  const throwIfStreamError = (): void => {
    const err = stream.error();
    if (err) throw err;
  };

  try {
    // 显式 identity：部分 CDN 边缘会对归档做透明 gzip，解压后字节数与 content-length 不可比
    const res = await httpFetch(url, {
      signal: ac.signal,
      headers: { 'accept-encoding': 'identity' },
    });
    timer.refresh(); // 响应头到达，转入流式阶段
    total = Number(res.headers.get('content-length')) || null;
    // 若服务端仍坚持压缩（undici 透明解压），长度校验失效，完整性交给 sha256
    encoded = Boolean(res.headers.get('content-encoding'));
    if (!res.body) throw new SdkvmError(`Empty response body: ${url}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      timer.refresh();
      throwIfStreamError();
      if (!out.write(chunk)) {
        await waitForDrain(out, ac.signal);
        // 背压等待期间收不到 chunk，计时器会空转误报"无数据"——drain 回来即刷新
        timer.refresh();
      }
      throwIfStreamError();
      hash.update(chunk);
      bytes += chunk.byteLength;
      onProgress?.(bytes, total);
    }
    throwIfStreamError();
    await new Promise<void>((resolve, reject) => {
      // end 回调同样可能因底层句柄卡死而不来（closeWriteStream 同理），有界等待
      const flushTimer = setTimeout(
        () => reject(new SdkvmError('Timed out flushing the download to disk', { hint: url })),
        CLOSE_TIMEOUT_MS,
      );
      out.end((err?: Error | null) => {
        clearTimeout(flushTimer);
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    // destroy 会让还在飞的 write 回调发出 ERR_STREAM_DESTROYED；上面的 error 监听负责接住
    await closeWriteStream(out);
    try {
      fs.rmSync(partFile, { force: true });
    } catch {
      // Windows 上句柄仍被卡死的流占用时删不掉：留给安装时的按龄清扫
    }
    if (stalled) {
      throw new SdkvmError(`Download stalled: no data for ${IDLE_TIMEOUT_MS / 1000}s (${bytes} bytes so far)`, {
        hint: url,
      });
    }
    if (err instanceof SdkvmError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new SdkvmError(`Download failed after ${bytes} bytes: ${detail}`, { hint: url });
  } finally {
    clearTimeout(timer);
  }

  if (bytes === 0) {
    fs.rmSync(partFile, { force: true });
    throw new SdkvmError(`Download incomplete: 0 bytes`, { hint: url });
  }
  if (total !== null && !encoded && bytes !== total) {
    fs.rmSync(partFile, { force: true });
    throw new SdkvmError(`Download incomplete: ${bytes}/${total} bytes`, { hint: url });
  }
  // 与安装目录落位一致：Windows 上杀毒可能短暂锁住刚写完的 .part
  await renameWithRetry(partFile, destFile);
  return { file: destFile, sha256: hash.digest('hex'), bytes, total };
}

export function cacheFileName(url: string): string {
  const safe = path.basename(new URL(url).pathname).replace(/[^\w.+-]/g, '_');
  return safe || `download-${Date.now()}`;
}
