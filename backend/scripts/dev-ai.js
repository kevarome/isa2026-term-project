import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { createApp } from '../src/app.js';
import { cloudflareApi, createWorkersAi } from './workers-ai.js';

const exec = promisify(execFile);
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
let pendingToken;

async function readWranglerToken() {
  try {
    const { stdout } = await exec(process.execPath, [wrangler, 'auth', 'token', '--json'], {
      timeout: 10000,
      windowsHide: true
    });
    const { token } = JSON.parse(stdout);
    if (token) return token;
  } catch {
    // Wrangler errors can include command output. Keep credential output private.
  }
  throw new Error('Sign in with `npx wrangler login` or set CLOUDFLARE_API_TOKEN.');
}

async function getToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  pendingToken ??= readWranglerToken().finally(() => { pendingToken = undefined; });
  return pendingToken;
}

async function getAccount(token) {
  const configured = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (configured) {
    if (!/^[0-9a-f]{32}$/i.test(configured)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to a Cloudflare account ID.');
    return configured;
  }
  const response = await fetch(`${cloudflareApi}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  const accounts = response.ok ? (await response.json()).result : null;
  if (accounts?.length === 1) return accounts[0].id;
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID to select the account with Workers AI access.');
}

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '8787' },
    'persist-to': { type: 'string' },
    var: { type: 'string' }
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a valid --port.');
  const modelOverride = values.var?.match(/^AI_MODEL:(.+)$/)?.[1];
  if (values.var && !modelOverride) throw new Error('Use --var AI_MODEL:<model ID> to select a model.');

  const account = await getAccount(await getToken());
  const platform = await getPlatformProxy({
    remoteBindings: false,
    persist: values['persist-to'] ? { path: join(values['persist-to'], 'v3') } : true
  });
  const env = { ...platform.env, AI: createWorkersAi(account, getToken), PASSWORD_RESET_MODE: 'local' };
  env.AI_MODEL = modelOverride ?? env.AI_MODEL;
  const server = createApp(env).listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
    console.log(`TicketMaestro API listening on http://localhost:${port} with live Workers AI.`);
    const stop = () => server.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await once(server, 'close');
  } finally {
    await platform.dispose();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
