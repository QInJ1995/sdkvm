import crypto from 'node:crypto';
import fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../src/net/download.js';

let dir: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sdkvm-dl-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** 构造一个可控响应：content-length/content-encoding 由用例指定，body 为明文 */
function stubFetch(body: string, headers: Record<string, string>) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (_input: unknown, init?: RequestInit) => {
    calls.push(init?.headers as Record<string, unknown>);
    return new Response(body, { status: 200, headers });
  };
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

describe('downloadFile 缓冲区', () => {
  it('源缓冲区在 write 时被复用，落盘内容和 sha256 仍是原字节', async () => {
    const payload = Buffer.from('hello world');
    const shared = new Uint8Array(payload);
    class ReusingWrite extends Writable {
      chunks: Buffer[] = [];
      override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        // 模拟 undici：交给 write 的若仍是源缓冲区，下一次填充会改掉还没落盘的字节
        if (chunk.byteOffset === shared.byteOffset && chunk.buffer === shared.buffer) shared.fill(0);
        this.chunks.push(Buffer.from(chunk));
        cb();
      }
    }
    const sink = new ReusingWrite();
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => sink as unknown as fs.WriteStream);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(shared);
        controller.close();
      },
    });
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-length': String(payload.length) },
      })) as typeof fetch;

    const dest = path.join(dir, 'reuse.zip');
    const r = await downloadFile('https://example.com/reuse.zip', dest);
    const written = Buffer.concat(sink.chunks);
    expect(written.equals(payload)).toBe(true);
    expect(r.sha256).toBe(crypto.createHash('sha256').update(payload).digest('hex'));
  });
});

describe('downloadFile 长度校验', () => {
  it('identity 响应：字节数与 content-length 一致时成功', async () => {
    const calls = stubFetch('hello world', { 'content-length': '11' });
    const dest = path.join(dir, 'a.zip');
    const r = await downloadFile('https://example.com/a.zip', dest);
    expect(r.bytes).toBe(11);
    expect(r.sha256).toBe(crypto.createHash('sha256').update('hello world').digest('hex'));
    expect(r.digest).toBe(r.sha256);
    expect(r.algorithm).toBe('sha256');
    // 显式要求不压缩
    expect(calls[0]).toMatchObject({ 'accept-encoding': 'identity' });
  });

  it('sha512 在下载流上累计，不再留下空的 sha256', async () => {
    stubFetch('hello world', { 'content-length': '11' });
    const dest = path.join(dir, 'sha512.zip');
    const r = await downloadFile('https://example.com/sha512.zip', dest, undefined, 'sha512');
    expect(r.algorithm).toBe('sha512');
    expect(r.digest).toBe(crypto.createHash('sha512').update('hello world').digest('hex'));
    expect(r.sha256).toBe('');
  });

  it('透明压缩（content-encoding 存在）：解压后字节数 > content-length 不再误判不完整', async () => {
    // 11 字节解压体 vs 线缆上 3 字节的“压缩长度”——正是 windows CI go zip 踩中的形态
    stubFetch('hello world', { 'content-length': '3', 'content-encoding': 'gzip' });
    const dest = path.join(dir, 'b.zip');
    const r = await downloadFile('https://example.com/b.zip', dest);
    expect(r.bytes).toBe(11);
    expect(r.sha256).toBe(crypto.createHash('sha256').update('hello world').digest('hex'));
  });

  it('content-encoding: identity 且截断：仍按 content-length 硬失败', async () => {
    stubFetch('hello', { 'content-length': '11', 'content-encoding': 'identity' });
    const dest = path.join(dir, 'identity.zip');
    await expect(downloadFile('https://example.com/identity.zip', dest)).rejects.toThrow(
      /Download incomplete: 5\/11 bytes/,
    );
  });

  it('无 content-encoding 且截断：仍硬失败并清理 .part', async () => {
    stubFetch('hello', { 'content-length': '11' });
    const dest = path.join(dir, 'c.zip');
    await expect(downloadFile('https://example.com/c.zip', dest)).rejects.toThrow(
      /Download incomplete: 5\/11 bytes/,
    );
    expect(existsSync(`${dest}.tmp-${process.pid}.part`)).toBe(false);
  });

  it('响应中途断开时销毁写流，不把 ERR_STREAM_DESTROYED 变成未处理错误', async () => {
    // write 回调故意晚于 destroy：复现大文件下载中断时 fs.WriteStream 的竞态
    class LateWriteStream extends Writable {
      override _write(_chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        setImmediate(() => {
          if (this.destroyed) {
            cb(
              Object.assign(new Error('Cannot call write after a stream was destroyed'), {
                code: 'ERR_STREAM_DESTROYED',
              }),
            );
            return;
          }
          cb();
        });
      }
    }
    vi.spyOn(fs, 'createWriteStream').mockImplementation(
      () => new LateWriteStream() as unknown as fs.WriteStream,
    );

    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          return;
        }
        controller.error(new Error('connection reset'));
      },
    });
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-length': '100' } })) as typeof fetch;

    const dest = path.join(dir, 'flutter.zip');
    await expect(downloadFile('https://example.com/flutter.zip', dest)).rejects.toThrow(
      /Download failed after \d+ bytes: connection reset/,
    );
    expect(existsSync(`${dest}.tmp-${process.pid}.part`)).toBe(false);
  });

  it('写流在 drain 之前出错时失败，而不是一直等 drain', async () => {
    class StuckWriteStream extends Writable {
      constructor() {
        super({ highWaterMark: 0 });
      }
      override _write(_chunk: Buffer, _enc: BufferEncoding, _cb: (err?: Error | null) => void): void {
        setImmediate(() => {
          this.destroy(new Error('disk full'));
        });
      }
    }
    vi.spyOn(fs, 'createWriteStream').mockImplementation(
      () => new StuckWriteStream() as unknown as fs.WriteStream,
    );
    globalThis.fetch = (async () =>
      new Response('hello world', { status: 200, headers: { 'content-length': '11' } })) as typeof fetch;

    const dest = path.join(dir, 'stuck.zip');
    await expect(downloadFile('https://example.com/stuck.zip', dest)).rejects.toThrow(/disk full/);
    expect(existsSync(`${dest}.tmp-${process.pid}.part`)).toBe(false);
  });

  it('写流一直不 drain 时，空闲超时会结束等待', async () => {
    vi.useFakeTimers();
    class NeverDrain extends Writable {
      constructor() {
        super({ highWaterMark: 0 });
      }
      override _write(): void {
        // 不调用回调，模拟磁盘不再接受数据
      }
    }
    vi.spyOn(fs, 'createWriteStream').mockImplementation(
      () => new NeverDrain() as unknown as fs.WriteStream,
    );
    globalThis.fetch = (async () =>
      new Response('hello world', { status: 200, headers: { 'content-length': '11' } })) as typeof fetch;

    const dest = path.join(dir, 'stall.zip');
    const pending = downloadFile('https://example.com/stall.zip', dest);
    const assertion = expect(pending).rejects.toThrow(/Download stalled/);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
