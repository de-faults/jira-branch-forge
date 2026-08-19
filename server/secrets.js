import crypto from 'node:crypto';

/**
 * In-memory token vault — Jira only.
 *
 * GitHub credentials are deliberately absent: GitHub access goes through the
 * `gh` CLI (server/lib/gh.js), which owns its own token. This process never
 * holds one, so there is nothing here to protect.
 *
 * Hard rules enforced here (not by convention elsewhere):
 *  - Nothing in this module is ever passed to better-sqlite3 or fs.
 *  - Token values are held in a Weakly-exposed closure; the only way out is
 *    `withToken()`, which hands the raw value to a callback and returns the
 *    callback's result. There is no `getToken()` to accidentally serialise.
 *  - Session objects returned to routes carry metadata only (login, avatar,
 *    scopes, expiry) — never the credential.
 *  - Process exit = credentials gone. No refresh persistence, by design.
 */

const sessions = new Map(); // sid -> { jira: Cred|null, pending: {} }

const REDACT = '[redacted]';

class Cred {
  #value;
  constructor(value, meta = {}) {
    this.#value = value;
    this.meta = meta;
  }
  use(fn) {
    return fn(this.#value);
  }
  rotate(value, meta = {}) {
    this.#value = value;
    this.meta = { ...this.meta, ...meta };
  }
  toJSON() {
    return REDACT;
  }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return REDACT;
  }
  toString() {
    return REDACT;
  }
}

export function newSessionId() {
  return crypto.randomBytes(24).toString('base64url');
}

export function ensureSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { jira: null, pending: {}, createdAt: Date.now() };
    sessions.set(sid, s);
  }
  return s;
}

export function getSession(sid) {
  return sid ? sessions.get(sid) || null : null;
}

export function dropSession(sid) {
  sessions.delete(sid);
}

export function setJiraTokens(sid, { accessToken, refreshToken, expiresIn }, meta) {
  ensureSession(sid).jira = new Cred(
    { accessToken, refreshToken },
    { ...meta, expiresAt: Date.now() + (expiresIn || 3600) * 1000 },
  );
}

export function withJiraTokens(sid, fn) {
  const cred = getSession(sid)?.jira;
  if (!cred) throw Object.assign(new Error('jira_not_connected'), { statusCode: 401 });
  return cred.use(fn);
}

export function jiraCred(sid) {
  return getSession(sid)?.jira || null;
}

/** Metadata only. This is the shape the browser is allowed to see. */
export function publicSession(sid) {
  const s = getSession(sid);
  return {
    jira: s?.jira
      ? {
          connected: true,
          ...s.jira.meta,
          expiresAt: undefined,
          expiresInSec: Math.max(0, Math.round((s.jira.meta.expiresAt - Date.now()) / 1000)),
        }
      : { connected: false },
  };
}
