import { spawn } from 'node:child_process';
import { config } from '../config.js';

/**
 * GitHub access via the `gh` CLI.
 *
 * The security win over an in-app OAuth flow: this process never sees a GitHub
 * token. `gh` reads its own credential from the OS keyring / hosts.yml and
 * injects it into the request itself. There is nothing for us to store, leak,
 * log, or hand to the browser.
 *
 * Everything here uses spawn with an argv array and no shell, so a repo name
 * or search string can never become a command.
 */

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 20 * 1024 * 1024;

// gh needs HOME (hosts.yml) and PATH. GH_TOKEN/GITHUB_TOKEN are forwarded
// untouched if the user set them — forwarded, never read into a JS variable.
const PASSTHROUGH = [
  'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'LANG',
];

function childEnv() {
  const env = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', CLICOLOR: '0' };
  for (const k of PASSTHROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function run(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('gh timed out'), { statusCode: 504 }));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) {
        child.kill('SIGKILL');
        return reject(Object.assign(new Error('gh output too large'), { statusCode: 502 }));
      }
      out += d;
    });
    child.stderr.on('data', (d) => { err += d.slice(0, 4096); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? Object.assign(new Error('gh CLI not found on PATH — install GitHub CLI'), { statusCode: 503 })
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });

    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** `gh api` path guard: only the shapes this app builds are accepted. */
function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\s\n\r]/.test(path)) {
    throw Object.assign(new Error('invalid api path'), { statusCode: 400 });
  }
  return path;
}

export async function ghApi(path, { method = 'GET', body, paginate = false, host } = {}) {
  const args = [
    'api', assertApiPath(path),
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
  ];
  const targetHost = host || config.github.host;
  if (targetHost) args.push('--hostname', targetHost);
  if (method !== 'GET') args.push('--method', method);
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');

  const { code, stdout, stderr } = await run(args, {
    stdin: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (code !== 0) throw ghError(stderr, stdout);
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  // --slurp wraps each page in an array; flatten back to one list.
  return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
}

function ghError(stderr, stdout) {
  const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || 502;
  let message = stderr.split('\n').find((l) => l.trim()) || 'gh api failed';
  try {
    const body = JSON.parse(stdout);
    if (body?.message) message = body.message;
  } catch { /* stdout was not JSON */ }
  if (/not logged|authentication|gh auth login/i.test(stderr)) {
    return Object.assign(new Error('github_not_connected'), { statusCode: 401 });
  }
  return Object.assign(new Error(message.replace(/^gh:\s*/, '')), { statusCode: status });
}

/**
 * Who gh is acting as, and with which scopes. `--include` gives us the
 * X-OAuth-Scopes header, which is how we tell the UI up front whether the
 * existing gh login can create a branch on a private corp repo.
 */
export async function ghIdentity() {
  const args = ['api', '--include', '/user'];
  if (config.github.host) args.push('--hostname', config.github.host);
  const { code, stdout, stderr } = await run(args);
  if (code !== 0) {
    const e = ghError(stderr, stdout);
    if (e.statusCode === 401 || e.statusCode === 503) return { connected: false, reason: e.message };
    throw e;
  }
  const split = stdout.indexOf('\n{');
  const headers = stdout.slice(0, split < 0 ? stdout.length : split);
  const user = split < 0 ? {} : JSON.parse(stdout.slice(split + 1));
  const scopes = (/x-oauth-scopes:\s*(.*)/i.exec(headers)?.[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    connected: true,
    login: user.login,
    name: user.name,
    avatar: user.avatar_url,
    scopes,
    // A fine-grained PAT reports no scopes at all; only warn when we can tell.
    missingScopes: scopes.length ? ['repo', 'read:org'].filter((s) => !scopes.includes(s)) : [],
    host: config.github.host || 'github.com',
  };
}

/** Accounts gh knows about, so the UI can say which one it is acting as. */
export async function ghAccounts() {
  const { code, stdout, stderr } = await run(['auth', 'status']);
  const text = `${stdout}\n${stderr}`;
  if (code !== 0) return [];
  const accounts = [];
  let host = null;
  for (const line of text.split('\n')) {
    const h = /^(\S+\.\S+)$/.exec(line.trim());
    if (h) host = h[1];
    const m = /Logged in to (\S+) account (\S+)/.exec(line);
    if (m) accounts.push({ host: m[1], login: m[2], active: false });
    if (/Active account: true/.test(line) && accounts.length) accounts.at(-1).active = true;
  }
  return accounts.filter((a) => !host || true);
}
