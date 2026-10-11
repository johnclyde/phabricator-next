import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { AuthScope } from '../shared/auth.ts';

const help = `Manage accounts for this local workspace (terminal access required).

  npm run accounts -- list
  npm run accounts -- create USERNAME --name "Display name"
  npm run accounts -- reset USERNAME
  npm run accounts -- disable USERNAME
  npm run accounts -- enable USERNAME
  npm run accounts -- transfer-local USERNAME
  npm run accounts -- token USERNAME --name "CLI access" --scopes read,write --days 30
  npm run accounts -- tokens USERNAME
  npm run accounts -- revoke USERNAME TOKEN_ID

Passwords are prompted without echo. For automation, explicitly use
--password-stdin with create/reset; passwords are never command-line arguments.
Token secrets are printed once. Store them privately; never commit them.
Scopes: read, write, review:local, review:hosted. Review scopes are explicit.
Workspace membership is separate from object and Space permissions.
Before enabling password sign-in, transfer-local explicitly hands local-only
policy grants, task and revision ownership, and project membership to the chosen enabled account. It preserves other grants, records
the terminal operator's action, and does not activate password authentication.
Set APP_AUTH_MODE=password and restart the loopback server to require sign-in.
`;

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Use an interactive terminal, or pass --password-stdin explicitly.');
  process.stderr.write(prompt);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  return new Promise<string>((resolvePassword, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.removeListener('data', input); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolvePassword(value);
    };
    const input = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') { finish(new Error('Password entry cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ') value += character;
        if (Buffer.byteLength(value) > 1024) { finish(new Error('Password exceeds 1024 UTF-8 bytes.')); return; }
      }
    };
    process.stdin.on('data', input);
  });
}

async function password(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    if (process.stdin.isTTY) throw new Error('--password-stdin requires redirected input. Use the hidden prompt in a terminal.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > 1026) throw new Error('Password input exceeds 1024 UTF-8 bytes plus a line ending.');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
  }
  const first = await hiddenPassword('New password: ');
  const confirmation = await hiddenPassword('Confirm password: ');
  if (first !== confirmation) throw new Error('Passwords do not match.');
  return first;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    name: { type: 'string' }, scopes: { type: 'string' }, days: { type: 'string' }, 'password-stdin': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, username, tokenId, ...extra] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (!['list', 'create', 'reset', 'disable', 'enable', 'transfer-local', 'token', 'tokens', 'revoke'].includes(command) || extra.length) throw new Error('Unknown command or extra arguments. Use --help.');
  if (command === 'list' && (username || tokenId)) throw new Error('list does not take an account name.');
  if (command !== 'list' && !username) throw new Error('Provide an account username.');
  if (command !== 'revoke' && tokenId) throw new Error('Unexpected extra argument.');
  if (values['password-stdin'] && !['create', 'reset'].includes(command)) throw new Error('--password-stdin is only used with create or reset.');
  const store = createStore({ path: process.env.DATABASE_PATH ?? resolve('.data/phabricator.sqlite') });
  try {
    const auth = createAuth({ database: store.database, mode: 'local', basePath: process.env.APP_BASE_PATH ?? '/', provisioning: true, transferTaskOwners: (fromId, toId, attribution) => store.transferTaskOwners(fromId, toId, attribution), transferRevisionAuthors: (fromId, toId, attribution) => store.transferLocalRevisionAuthors(fromId, toId, attribution), transferLocalProjectMemberships: (fromId, toId, attribution) => store.transferLocalProjectMemberships(fromId, toId, attribution) });
    if (command === 'list') { console.log(JSON.stringify(auth.listAccounts(), null, 2)); return; }
    if (command === 'create') {
      const created = await auth.createAccount({ username: username!, displayName: values.name ?? username!, password: await password(Boolean(values['password-stdin'])) });
      console.log(`Created ${created.username} (${created.id}). Start the server with APP_AUTH_MODE=password to require sign-in.`); return;
    }
    const account = auth.listAccounts().find(item => item.username === username!.toLowerCase());
    if (!account) throw new Error('Account not found.');
    if (command === 'reset') { await auth.resetPassword(account.id, await password(Boolean(values['password-stdin']))); console.log('Password reset. Existing sessions and access tokens were revoked.'); }
    if (command === 'disable' || command === 'enable') { auth.setAccountDisabled(account.id, command === 'disable'); console.log(`${account.username} ${command === 'disable' ? 'disabled; credentials revoked' : 'enabled'}.`); }
    if (command === 'transfer-local') {
      const result = auth.transferLocalPolicies(account.id);
      console.log(`Transferred local-only grants to ${result.account.username} (${result.account.id}): ${result.spaces} Space(s), ${result.objects} object(s), ${result.tasks} task owner(s), ${result.revisions} revision owner(s), ${result.projectMemberships} project membership(s). Password authentication remains inactive.`);
    }
    if (command === 'tokens') console.log(JSON.stringify(auth.listTokens(account.id), null, 2));
    if (command === 'revoke') { if (!tokenId) throw new Error('Provide the token ID to revoke.'); auth.revokeToken(account.id, tokenId); console.log('Access token revoked.'); }
    if (command === 'token') {
      if (!values.name || !values.scopes) throw new Error('Provide --name and an explicit comma-separated --scopes list.');
      const result = auth.createToken(account.id, { name: values.name, scopes: values.scopes.split(',') as AuthScope[], ...(values.days === undefined ? {} : { expiresInDays: Number(values.days) }) });
      console.error(`Token ${result.record.id} expires ${result.record.expiresAt}. Copy the secret below now; it is shown once.`);
      console.log(result.token);
    }
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Account operation failed.'); process.exitCode = 1; });
