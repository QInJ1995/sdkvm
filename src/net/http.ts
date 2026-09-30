import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
// 用 undici 自己的 RequestInit/Response 类型：@types/node 的全局版本来自另一个
// undici-types 拷贝，两者结构不完全兼容（代理路径的 init 带 dispatcher，类型须同源）
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

// 显式代理环境（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，尊重 NO_PROXY）此前被全局 fetch
// 静默忽略——企业网内表现为所有请求直连超时。
// 注意不能用 setGlobalDispatcher：npm 版 undici 写的 symbol 与 Node 内置 fetch 共享，
// 设了会把进程内所有内置 fetch 请求也改道进代理（包括无关代码）；
// 这里把 agent 作为 per-request dispatcher 只传给 undici 自己的 fetch。
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** 每次调用现查环境而非模块加载时定格：测试可切换，坏值也不影响后续调用。
 *  变量缺失时 `?.trim()` 短路成 undefined，直接 `!== ''` 会恒真——必须先归一成空串 */
function proxyEnvPresent(): boolean {
  return PROXY_ENV_KEYS.some((k) => (process.env[k] ?? '').trim() !== '');
}

/** EnvHttpProxyAgent 的实验性警告（UNDICI-EHPA）会在每条命令的 stderr 打两行噪声。
 *  emitWarning 经 nextTick 延迟发射：构造前装过滤器，构造时排队的警告先出队被滤掉，
 *  再在队列尾还原——其余警告不受影响。按警告名精确匹配，绝不误吞。 */
function silenceEhpaWarning(): void {
  const origEmit = process.emit.bind(process) as (event: string | symbol, ...args: unknown[]) => boolean;
  process.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'warning' && (args[0] as Error | undefined)?.name === 'UNDICI-EHPA') return true;
    return origEmit(event, ...args);
  }) as typeof process.emit;
  process.nextTick(() => {
    process.emit = origEmit as typeof process.emit;
  });
}

let proxyAgent: EnvHttpProxyAgent | null | undefined;

/** 惰性建进程级单例；初始化失败（坏变量值）退回直连，失败信息足够定位 */
function getProxyAgent(): EnvHttpProxyAgent | null {
  if (proxyAgent === undefined) {
    silenceEhpaWarning();
    try {
      proxyAgent = new EnvHttpProxyAgent();
    } catch {
      proxyAgent = null;
    }
  }
  return proxyAgent;
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
    // 代理激活时必须走 undici 自己的 fetch 并带 per-request dispatcher；
    // 其余场景走全局 fetch——行为与旧版一致，测试也仍可 stub 全局 fetch
    const agent = proxyEnvPresent() ? getProxyAgent() : null;
    if (agent) return undiciFetch(url, { ...merged, dispatcher: agent });
    return globalThis.fetch(
      url,
      merged as unknown as Parameters<typeof globalThis.fetch>[1],
    ) as unknown as Promise<Response>;
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

/** 可重试状态：429 与"网关侧瞬时"5xx。501/505/507 这类永久性错误重试三次只是白等 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** fetch 封装：可重试 5xx/429/网络错误重试，4xx 不重试直接抛 */
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
      // 429 尊重 Retry-After（秒数形式），封顶 30s
      if (RETRYABLE_STATUS.has(res.status) && attempt < RETRIES) {
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
      // 非重试语义的 HttpError（4xx、永久性 5xx）立即上抛，重试留给出错可恢复的路径
      if (err instanceof HttpError && !RETRYABLE_STATUS.has(err.status)) throw err;
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

/** httpJson 的变体：把响应头一并返回（分页游标等需要读 header 的调用方用）。
 *  body 同样纳入重试与读取预算——直接 httpFetch 后 res.json() 的裸用法学了
 *  连接层预算却漏掉 body 挂起，别再新增那样的调用方。 */
export async function httpJsonWithHeaders<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  return withBodyRetry(url, { ...init, headers: { accept: 'application/json', ...init.headers } }, async (res) => ({
    data: (await res.json()) as T,
    headers: res.headers,
  }));
}
