import { defineConfig, loadEnv } from 'vite';
import { normalizeBasePath } from './shared/mount';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'APP_');
  const base = normalizeBasePath(process.env.APP_BASE_PATH ?? env.APP_BASE_PATH ?? '/');
  return {
    root: 'client', envDir: process.cwd(), base,
    build: { outDir: '../dist', emptyOutDir: true },
    server: { port: 5173, strictPort: true, proxy: { [`^${base}api(?:/|$)`]: 'http://127.0.0.1:4310' } },
  };
});
