import { config, configHealth } from '../config.js';
import { ghIdentity, ghAccounts } from '../lib/gh.js';
import { buildAuthorizeUrl, completeAuthCode } from '../auth/jira.js';
import { publicSession, dropSession } from '../secrets.js';

export default async function authRoutes(app) {
  // GitHub state is not session state: it is whatever `gh` is logged in as on
  // this machine. Read it live on every session poll.
  app.get('/api/session', async (req) => {
    const github = await ghIdentity().catch((e) => ({ connected: false, reason: e.message }));
    return {
      ...publicSession(req.sid),
      github,
      config: configHealth(),
      branchTemplate: config.branchTemplate,
      orgs: config.github.orgs,
    };
  });

  app.get('/api/github/accounts', async () => ghAccounts());

  app.post('/api/auth/logout', async (req) => {
    dropSession(req.sid);
    return { ok: true };
  });

  // --- Jira OAuth 2.0 3LO + PKCE -------------------------------------------
  app.post('/api/auth/jira/start', async (req) => ({ authorizeUrl: buildAuthorizeUrl(req.sid) }));

  app.get('/api/auth/jira/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query;
    if (error) return reply.type('text/html').send(closingPage(false, desc || error));
    try {
      await completeAuthCode(req.sid, { code, state });
      return reply.type('text/html').send(closingPage(true));
    } catch (err) {
      req.log.warn({ msg: 'jira callback failed', reason: err.message });
      return reply.type('text/html').send(closingPage(false, err.message));
    }
  });
}

function closingPage(ok, message = '') {
  const safe = String(message).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Failed'}</title>
<style>body{background:#0d1117;color:#e6edf3;font:14px -apple-system,Segoe UI,sans-serif;
display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}
b{color:${ok ? '#3fb950' : '#f85149'};font-size:18px}</style>
<div><b>${ok ? 'Jira connected' : 'Jira connection failed'}</b>
<p>${ok ? 'You can close this tab.' : safe}</p></div>
<script>setTimeout(()=>window.close(),${ok ? 1200 : 6000})</script>`;
}
