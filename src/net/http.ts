import { SdkvmError } from '../util/errors.js';
import { getVersion } from '../cli/misc.js';

const UA = `sdkvm/${getVersion()} (npm sdkvm)`;
const CONNECT_TIMEOUT_MS = 30_000;
const RETRIES = 3;

export class HttpError extends SdkvmError {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message, { hint: `URL: ${url}` });
    this.name = 'HttpError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 不再读取的响应要取消，否则重定向和 4xx 会占着连接。 */
async function releaseBody(res: Response): Promise<void> {
  await res.body?.cancel()?.catch(() => undefined);
}

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  const res = await fetch(url, { ...init, signal, headers: { 'user-agent': UA, ...init.headers } });
  return res;
}

/** https 请求被重定向降级到 http 时拒绝（fetch 默认会跟随降级）；抛错前释放 body */
async function assertNoDowngrade(requestedUrl: string, res: Response): Promise<void> {
  if (!res.url) return;
  let from: URL;
  let to: URL;
  try {
    from = new URL(requestedUrl);
    to = new URL(res.url);
  } catch {
    return;
  }
  if (from.protocol === 'https:' && to.protocol !== 'https:') {
    await releaseBody(res);
    throw new HttpError(`Blocked redirect downgrade ${from.protocol}// → ${to.protocol}//`, 0, res.url);
  }
}

/** fetch 封装：5xx/网络错误重试，4xx 不重试直接抛 */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetchOnce(url, init);
      // redirect: manual 的 3xx 是调用方要解析的正常结果，不算错误
      if (init.redirect === 'manual' && res.status >= 300 && res.status < 400) {
        await releaseBody(res);
        return res;
      }
      // 降级检查对任意最终状态生效：降级到 http 后的 404/5xx 同样不能放过
      await assertNoDowngrade(url, res);
      if (res.status >= 500 && attempt < RETRIES) {
        await releaseBody(res);
        lastErr = new HttpError(`Server error ${res.status}`, res.status, url);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        await releaseBody(res);
        throw new HttpError(`HTTP ${res.status} ${res.statusText || ''}`.trim(), res.status, url);
      }
      return res;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err;
      lastErr = err;
      if (attempt < RETRIES) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  if (lastErr instanceof SdkvmError) throw lastErr;
  throw new SdkvmError(`Network error after ${RETRIES} attempts: ${url}`, {
    hint: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}

/**
 * 读 body 也纳入重试：连接中途断开时 res.text()/res.json() 才失败，
 * fetch 本身已"成功"，原实现会把这类瞬时错误直接抛给上层。
 */
async function withBodyRetry<T>(url: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const res = await httpFetch(url, init);
    try {
      return await read(res);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new SdkvmError(`Network error reading response body: ${url}`, {
    hint: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}

export async function httpJson<T>(url: string): Promise<T> {
  return withBodyRetry(url, { headers: { accept: 'application/json' } }, (res) => res.json() as Promise<T>);
}

export async function httpText(url: string): Promise<string> {
  return withBodyRetry(url, {}, (res) => res.text());
}
