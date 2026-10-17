import { createHash } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { normalizeBasePath } from './shared/mount';

/** Pin the complete public editor shell, including fonts not requested until the first equation. */
export function offlineShellManifest(base: string): Plugin {
  return {
    name: 'offline-shell-manifest', apply: 'build', enforce: 'post',
    // Vite's import-analysis hook rewrites lazy-import preload tables during
    // generateBundle, after ordinary post plugins. Hash the final chunk bytes.
    generateBundle: { order: 'post', handler(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('The offline shell requires index.html.');
      const files = Object.values(bundle).filter(item => /^assets\/[A-Za-z0-9_.-]+\.(?:js|mjs|css|woff2?|ttf)$/.test(item.fileName) &&
        !/^assets\/(?:transcription-(?:worker|runtime)-|pdf\.worker)/.test(item.fileName)).map(item => {
        const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
        return { path: item.fileName, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }).sort((a, b) => a.path.localeCompare(b.path));
      if (!files.some(file => file.path.endsWith('.js')) || !files.some(file => file.path.endsWith('.css'))) throw new Error('The offline shell requires built JavaScript and CSS.');
      const manifest = JSON.stringify({ format: 'phabricator.offline-shell.v1', files }) + '\n';
      const path = `assets/offline-shell-${createHash('sha256').update(manifest).digest('hex')}.json`;
      this.emitFile({ type: 'asset', fileName: path, source: manifest });
      html.source = Buffer.from(html.source).toString().replace('</head>', `<meta name="application-shell" content="${base}${path}"/></head>`);
    } },
  };
}

/** Public runtime assets are installed explicitly, independently of the app shell. */
function transcriptionRuntimeManifest(): Plugin {
  return {
    name: 'transcription-runtime-integrity', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).filter(item => /^assets\/transcription-(?:worker|runtime)-[A-Za-z0-9_-]+\.(?:js|mjs|wasm)$/.test(item.fileName)).map(item => {
        const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
        return { path: item.fileName, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }).sort((a, b) => a.path.localeCompare(b.path));
      if (files.length !== 3 || !['.js', '.mjs', '.wasm'].every(extension => files.some(file => file.path.endsWith(extension)))) throw new Error('Expected exactly one self-contained transcription worker, one WASM factory and one WASM binary.');
      this.emitFile({ type: 'asset', fileName: 'transcription-runtime.json', source: JSON.stringify({ format: 'phabricator.transcription-runtime.v1', files }) + '\n' });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'APP_');
  const base = normalizeBasePath(process.env.APP_BASE_PATH ?? env.APP_BASE_PATH ?? '/');
  return {
    root: 'client', envDir: process.cwd(), base,
    plugins: [transcriptionRuntimeManifest(), offlineShellManifest(base)],
    worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', inlineDynamicImports: true } } },
    build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { output: {
      assetFileNames: asset => asset.names.some(name => /^ort-wasm-simd-threaded\.(?:mjs|wasm)$/.test(name)) ? 'assets/transcription-runtime-[hash].[ext]' : 'assets/[name]-[hash].[ext]',
    } } },
    server: { port: 5173, strictPort: true, proxy: { [`^${base}api(?:/|$)`]: 'http://127.0.0.1:4310' } },
  };
});
