import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
// 用 undici 自己的 RequestInit/Response 类型：@types/node 的全局版本来自另一个
// undici-types 拷贝，两者结构不完全兼容（本文件所有请求都走 undiciFetch，类型须同源）
import type { RequestInit, Response } from 'undici';
import { SdkvmError } from '../util/errors.js';
import { getVersion } from '../cli/misc.js';

const UA = `sdkvm/${getVersion()} (npm sdkvm)`;
/** 连接/响应头预算：只覆盖到 fetch 返回，body 阶段另有 BODY_TIMEOUT_MS。
 * AbortSignal.timeout 是总时长——直接套在整个请求上会把慢速大响应体在 30s 处掐断。 */
const CONNECT_TIMEOUT_MS = 30_000;
/** 元数据响应体（JSON/文本）的读取预算：到点取消连接并按网络错误重试 */
const BODY_TIMEOUT_MS = 60_000;
const RETRIES = 3;
/** 429 重试上限：尊重 Retry-After，但不让服务端把我们挂住太久 */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

// 显式代理环境（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）此前被全局 fetch 静默忽略——
// 企业网内表现为所有请求直连超时。检测到任一变量就装 EnvHttpProxyAgent（尊重 NO_PROXY）。
// 注意 npm 版 undici 的 setGlobalDispatcher 只作用于它自己的 fetch：这里连 fetch
// 一起从 undici 导入，两者配套。初始化失败（坏变量值）退回直连
const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(
  (k) => process.env[k] && process.env[k]!.trim() !== '',
);
if (hasProxyEnv) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    // 代理变量存在但初始化失败：直连尝试，失败信息足够定位
  }
}

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

/** undici 把真实原因（ENOTFOUND / ECONNREFUSED / ERR_TLS_*）放在 err.cause；
 *  只留 err.message 会全部退化成无信息量的 "fetch failed"。 */
function describeErr(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message}: ${detail}` : err.message;
}

/** read 到点未完成即放弃（连接随后由调用方释放），按可重试错误抛出 */
function withReadBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TypeError(`response body timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  const go = (signal: AbortSignal | null | undefined): Promise<Response> => {
    const merged = { ...init, signal, headers: { 'user-agent': UA, ...init.headers } };
    // 代理激活时必须走 undici 实例自己的 fetch（其 setGlobalDispatcher 只作用于该实例）；
    // 其余场景走全局 fetch——行为与旧版一致，测试也仍可 stub 全局 fetch
    return hasProxyEnv
      ? undiciFetch(url, merged)
      : (globalThis.fetch(url, merged as unknown as Parameters<typeof globalThis.fetch>[1]) as unknown as Promise<Response>);
  };
  // 调用方自带 signal（downloadFile 的空闲超时）原样透传；否则只给"到响应头为止"的
  // 预算：fetch 返回即停表。AbortSignal.timeout 会跟着请求走到底，慢速大响应体
  // 会在 30s 处被整体掐断（元数据 API 常见），body 阶段交给 withReadBudget。
  if (init.signal) {
    return go(init.signal);
  }
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`no response within ${CONNECT_TIMEOUT_MS / 1000}s`)),
    CONNECT_TIMEOUT_MS,
  );
  try {
    return await go(ac.signal);
  } finally {
    clearTimeout(timer);
  }
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
      // 429 与 5xx 同为可重试；429 尊重 Retry-After（秒数形式），封顶 30s
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const status = res.status;
        const retryAfter = Number(res.headers.get('retry-after'));
        await releaseBody(res);
        lastErr = new HttpError(
          status === 429 ? `Rate limited (HTTP 429)` : `Server error ${status}`,
          status,
          url,
        );
        const waitMs =
          status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : 500 * 2 ** (attempt - 1);
        await sleep(waitMs);
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
    hint: describeErr(lastErr),
  });
}

/**
 * 读 body 也纳入重试：连接中途断开时 res.text()/res.json() 才失败，
 * fetch 本身已"成功"，原实现会把这类瞬时错误直接抛给上层。
 * 只重试网络类读取失败（undici 一律抛 TypeError）；JSON 语法错（镜像返回 HTML 之类）
 * 是确定性错误，重试三次只是白等。
 */
async function withBodyRetry<T>(url: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const res = await httpFetch(url, init);
    try {
      return await withReadBudget(read(res), BODY_TIMEOUT_MS);
    } catch (err) {
      await releaseBody(res);
      lastErr = err;
      if (!(err instanceof TypeError)) {
        throw new SdkvmError(`Failed to read the response from ${url}: ${describeErr(err)}`);
      }
      if (attempt < RETRIES) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new SdkvmError(`Network error reading response body: ${url}`, {
    hint: describeErr(lastErr),
  });
}

export async function httpJson<T>(url: string): Promise<T> {
  return withBodyRetry(url, { headers: { accept: 'application/json' } }, (res) => res.json() as Promise<T>);
}

export async function httpText(url: string): Promise<string> {
  return withBodyRetry(url, {}, (res) => res.text());
}
