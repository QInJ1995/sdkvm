import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpText } from '../src/net/http.js';

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
