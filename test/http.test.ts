import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpJson, httpText } from '../src/net/http.js';
import { SdkvmError } from '../src/util/errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造带最终 URL 的 Response（new Response 的 url 恒为空串） */
function resWithUrl(body: string, url: string): Response {
  const res = new Response(body);
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

describe('httpFetch redirect downgrade guard', () => {
  it('rejects an https → http redirect downgrade', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resWithUrl('evil', 'http://downgraded.example/x')),
    );
    await expect(httpText('https://origin.example/x')).rejects.toThrow(/downgrade/i);
  });

  it('allows https → https', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resWithUrl('{"ok":1}', 'https://final.example/x')),
    );
    await expect(httpText('https://origin.example/x')).resolves.toBe('{"ok":1}');
  });
});

describe('body 读取重试', () => {
  it('res.text() 中途失败会重试整个请求', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          const bad = new Response('partial');
          Object.defineProperty(bad, 'text', {
            value: async () => {
              throw new TypeError('aborted');
            },
          });
          return bad;
        }
        return new Response('ok');
      }),
    );
    await expect(httpText('https://retry.example/x')).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('JSON 语法错误是确定性错误，不再重试三次白等', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        const bad = new Response('<html>gateway error</html>');
        Object.defineProperty(bad, 'json', {
          value: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        });
        return bad;
      }),
    );
    const err: unknown = await httpJson('https://bad.example/x').catch((e) => e);
    expect(err).toBeInstanceOf(SdkvmError);
    expect((err as Error).message).toMatch(/Failed to read the response from/);
    expect(calls).toBe(1);
  });

  it('重试穷尽后 hint 透传 err.cause 的底层错误码', async () => {
    // undici 把 ENOTFOUND/ECONNREFUSED 放在 err.cause：只留 message 会退化成 "fetch failed"
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' },
        });
      }),
    );
    const err: unknown = await httpText('https://down.example/x').catch((e) => e);
    expect(err).toBeInstanceOf(SdkvmError);
    expect(String((err as SdkvmError).hint)).toMatch(/ECONNREFUSED/);
  });
});

describe('可重试状态码分类', () => {
  it('502 重试后成功', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('bad gateway', { status: 502 }) : new Response('ok');
      }),
    );
    await expect(httpText('https://flaky.example/x')).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('501 是永久性错误：立即上抛不重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('not implemented', { status: 501 });
      }),
    );
    await expect(httpText('https://perm.example/x')).rejects.toThrow(/501/);
    expect(calls).toBe(1);
  });

  it('429 尊重 Retry-After 后成功', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
        }
        return new Response('ok');
      }),
    );
    await expect(httpText('https://limited.example/x')).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('显式代理环境变量走 undici per-request dispatcher', () => {
  it('routes through undici fetch with a dispatcher and leaves global fetch alone', async () => {
    const dispatchers: unknown[] = [];
    vi.doMock('undici', async (importOriginal) => {
      const orig = await importOriginal<typeof import('undici')>();
      return {
        ...orig,
        fetch: vi.fn(async (_url: string, init?: { dispatcher?: unknown }) => {
          dispatchers.push(init?.dispatcher);
          return new Response('via-proxy');
        }),
      };
    });
    vi.resetModules();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7899';
    try {
      // 动态 import 拿到挂着 undici mock 的新模块实例（proxyAgent 单例也随之重置）
      const { httpText: freshHttpText } = await import('../src/net/http.js');
      await expect(freshHttpText('https://behind-proxy.example/x')).resolves.toBe('via-proxy');
      expect(dispatchers.length).toBe(1);
      expect(dispatchers[0]).toBeTruthy();
    } finally {
      delete process.env.HTTPS_PROXY;
      vi.doUnmock('undici');
      vi.resetModules();
    }
  });
});
