import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const args = process.argv.slice(2);
const selectedProject = args.some(argument => argument === '--project' || argument.startsWith('--project='));
let outputRoot = '.data/browser-results';
const forwarded: string[] = [];
for (let index = 0; index < args.length; index++) {
  const argument = args[index]!;
  if (!selectedProject && (argument === '--output' || argument.startsWith('--output='))) {
    const value = argument === '--output' ? args[++index] : argument.slice('--output='.length);
    if (!value || (argument === '--output' && value.startsWith('--'))) {
      console.error('--output requires a directory.'); process.exit(1);
    }
    outputRoot = value;
  } else forwarded.push(argument);
}

// Each viewport gets a fresh test server and database. Sharing one password
// workspace across the entire suite otherwise exhausts the real login limit.
// Explicit project selection remains available for focused local runs.
for (const project of selectedProject ? [null] : ['desktop', 'mobile']) {
  const result = spawnSync(process.execPath, [cli, 'test',
    ...(project ? ['--project', project] : []),
    ...(project ? ['--output', join(outputRoot, project)] : []),
    ...forwarded,
  ], { stdio: 'inherit', env: process.env });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? (result.signal === 'SIGINT' ? 130 : 1));
}
