import 'dotenv/config';
import crypto from 'node:crypto';

const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const config = {
  // Loopback only. Never 0.0.0.0 — this service holds live OAuth sessions.
  host: '127.0.0.1',
  port: int(process.env.PORT, 4178),
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  },
  // Rotated every boot, so every restart invalidates all sessions. That is the
  // point: tokens live in memory only, so a session that outlives the process
  // would be a session pointing at nothing.
  cookieSecret: crypto.randomBytes(32).toString('hex'),
  sessionCookie: 'jbf_sid',

  github: {
    // Auth is delegated entirely to the `gh` CLI: it holds the credential, we
    // never see one. Nothing to configure here beyond scoping and host.
    host: process.env.GH_HOST || '',
    orgs: (process.env.GITHUB_ORGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  jira: {
    clientId: process.env.JIRA_CLIENT_ID || '',
    clientSecret: process.env.JIRA_CLIENT_SECRET || '',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    api: 'https://api.atlassian.com',
    scope: [
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'offline_access',
    ].join(' '),
    get redirectUri() {
      return `${config.origin}/api/auth/jira/callback`;
    },
  },

  // Where to look for clones that already exist on this machine. The repo
  // picker reads these instead of listing every repo in the org.
  repoScan: {
    roots: (process.env.REPO_SCAN_ROOTS || '~/git')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    depth: int(process.env.REPO_SCAN_DEPTH, 3),
    max: int(process.env.REPO_SCAN_MAX, 500),
  },

  branchTemplate: process.env.BRANCH_TEMPLATE || '{type}/{key}-{slug}',
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
};

export function configHealth() {
  const missing = [];
  if (!config.jira.clientId) missing.push('JIRA_CLIENT_ID');
  return { missing, ready: missing.length === 0 };
}
