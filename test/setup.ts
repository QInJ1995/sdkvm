// 测试大量 stub globalThis.fetch；宿主机若设了代理变量，http.ts 会改走 undici 的
// fetch（带 per-request dispatcher），stub 失效、请求打到真实网络。统一清掉保证确定性。
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key];
}
