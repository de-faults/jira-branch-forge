import crypto from 'node:crypto';
import { config } from '../config.js';
import { req } from '../lib/http.js';
import { ensureSession, setJiraTokens, jiraCred } from '../secrets.js';

const b64url = (buf) => buf.toString('base64url');

/**
 * OAuth 2.0 authorization code + PKCE (S256), loopback redirect.
 * `state` is bound to the session cookie, verifier never leaves the process.
 */
export function buildAuthorizeUrl(sid) {
  if (!config.jira.clientId) {
    throw Object.assign(new Error('JIRA_CLIENT_ID is not set'), { statusCode: 503 });
  }
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  ensureSession(sid).pending.jira = { verifier, state, createdAt: Date.now() };

  const url = new URL(config.jira.authorizeUrl);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', config.jira.clientId);
  url.searchParams.set('scope', config.jira.scope);
  url.searchParams.set('redirect_uri', config.jira.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function completeAuthCode(sid, { code, state }) {
  const pending = ensureSession(sid).pending.jira;
  if (!pending) throw Object.assign(new Error('no pending jira authorization'), { statusCode: 400 });
  // Timing-safe compare, and the state is single-use whatever the outcome.
  const ok =
    state &&
    pending.state.length === state.length &&
    crypto.timingSafeEqual(Buffer.from(pending.state), Buffer.from(state));
  delete ensureSession(sid).pending.jira;
  if (!ok) throw Object.assign(new Error('state mismatch'), { statusCode: 400 });
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    throw Object.assign(new Error('authorization expired'), { statusCode: 400 });
  }

  const body = {
    grant_type: 'authorization_code',
    client_id: config.jira.clientId,
    code,
    redirect_uri: config.jira.redirectUri,
    code_verifier: pending.verifier,
  };
  if (config.jira.clientSecret) body.client_secret = config.jira.clientSecret;

  const tok = await req(config.jira.tokenUrl, { method: 'POST', body });
  const me = await req(`${config.jira.api}/me`, { token: tok.access_token }).catch(() => ({}));

  setJiraTokens(
    sid,
    { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresIn: tok.expires_in },
    {
      account: me.email || me.name || 'connected',
      name: me.name,
      avatar: me.picture,
      accountId: me.account_id,
      connectedAt: Date.now(),
    },
  );
}

/**
 * Refresh in place. Atlassian rotates refresh tokens, so the new one replaces
 * the old inside the same in-memory credential — nothing is written anywhere.
 */
async function refresh(sid) {
  const cred = jiraCred(sid);
  const refreshToken = cred?.use((v) => v.refreshToken);
  if (!refreshToken) throw Object.assign(new Error('jira_reauth_required'), { statusCode: 401 });

  const body = {
    grant_type: 'refresh_token',
    client_id: config.jira.clientId,
    refresh_token: refreshToken,
  };
  if (config.jira.clientSecret) body.client_secret = config.jira.clientSecret;

  const tok = await req(config.jira.tokenUrl, { method: 'POST', body }).catch(() => {
    throw Object.assign(new Error('jira_reauth_required'), { statusCode: 401 });
  });
  cred.rotate(
    { accessToken: tok.access_token, refreshToken: tok.refresh_token || refreshToken },
    { expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 },
  );
}

/** Every Jira call goes through here so expiry handling is never forgotten. */
export async function jiraFetch(sid, cloudId, path, init = {}) {
  const cred = jiraCred(sid);
  if (!cred) throw Object.assign(new Error('jira_not_connected'), { statusCode: 401 });
  if (Date.now() > (cred.meta.expiresAt || 0) - 60_000) await refresh(sid);

  const base = cloudId ? `${config.jira.api}/ex/jira/${encodeURIComponent(cloudId)}` : config.jira.api;
  const url = `${base}${path}`;
  const call = () => cred.use((v) => req(url, { ...init, token: v.accessToken }));

  try {
    return await call();
  } catch (err) {
    if (err.statusCode === 401) {
      await refresh(sid);
      return call();
    }
    throw err;
  }
}
