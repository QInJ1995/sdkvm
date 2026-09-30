import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: false,
  dts: false,
  // 脚本安装解压的是 npm pack 产物，不含 node_modules；依赖必须打进 dist
  noExternal: ['commander', 'picocolors', 'undici'],
  // undici 的 CJS 内部 require('node:assert') 等内置模块；纯 ESM 输出没有模块级
  // require，esbuild 的动态 require shim 会直接抛
  // "Dynamic require of assert is not supported"。注入 createRequire 让 shim
  // 在运行时能解析内置模块（esbuild 官方推荐做法）
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});
