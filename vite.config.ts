import { createHash } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { normalizeBasePath } from './shared/mount';

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
    plugins: [transcriptionRuntimeManifest()],
    worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', inlineDynamicImports: true } } },
    build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { output: {
      assetFileNames: asset => asset.names.some(name => /^ort-wasm-simd-threaded\.(?:mjs|wasm)$/.test(name)) ? 'assets/transcription-runtime-[hash].[ext]' : 'assets/[name]-[hash].[ext]',
    } } },
    server: { port: 5173, strictPort: true, proxy: { [`^${base}api(?:/|$)`]: 'http://127.0.0.1:4310' } },
  };
});
