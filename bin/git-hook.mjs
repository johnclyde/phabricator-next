#!/usr/bin/env node
// Invoked only by the server's disposable, operator-owned Git hook directory.
import { request } from 'node:http';

try {
  const phase = process.argv[2];
  const socketPath = process.env.PHAB_GIT_HOOK_SOCKET;
  const capability = process.env.PHAB_GIT_HOOK_CAPABILITY;
  if (!['pre', 'post'].includes(phase) || !socketPath || !capability) throw new Error();
  let stdin = '';
  for await (const chunk of process.stdin) {
    stdin += chunk.toString('utf8');
    if (Buffer.byteLength(stdin) > 512_000) throw new Error();
  }
  const payload = JSON.stringify({ stdin, quarantine: process.env.GIT_OBJECT_DIRECTORY ?? null, alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? null });
  const result = await new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/' + phase, method: 'POST', headers: { Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 90_000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); if (body.length > 8_000) req.destroy(new Error()); });
      res.on('end', () => { try { const value = JSON.parse(body); if (res.statusCode !== 200 || value.allowed !== true) reject(new Error()); else resolve(value); } catch { reject(new Error()); } });
    });
    req.on('timeout', () => req.destroy(new Error())); req.on('error', reject); req.end(payload);
  });
  if (!result) throw new Error();
} catch {
  console.error('Repository checks could not authorize this operation. Inspect the repository receive history.');
  process.exitCode = 1;
}
