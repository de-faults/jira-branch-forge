import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configHealth } from './config.js';
import { newSessionId, ensureSession } from './secrets.js';
import { redact } from './lib/http.js';
import authRoutes from './routes/auth.js';
import jiraRoutes from './routes/jira.js';
import githubRoutes from './routes/github.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // The logger is the most likely place for a credential to leak. Pin the
    // serialisers so headers and bodies are never printed verbatim.
    serializers: {
      req: (r) => ({ method: r.method, url: String(r.url).split('?')[0] }),
      res: (r) => ({ statusCode: r.statusCode }),
      err: (e) => ({ type: e.name, message: e.message, statusCode: e.statusCode }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'body.code', 'body.token'],
      censor: '[redacted]',
    },
  },
  trustProxy: false,
});

await app.register(cookie, { secret: config.cookieSecret });

// Loopback-only dev origins. Anything else is refused for state-changing calls.
const ALLOWED_ORIGINS = new Set(
  [config.port, 5173].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]),
);

app.addHook('onRequest', async (req, reply) => {
  reply.headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  });

  // Session cookie: opaque id, signed, httpOnly. It maps to in-memory creds
  // only — stealing it off-box buys nothing once the process restarts.
  let sid = null;
  const raw = req.cookies?.[config.sessionCookie];
  if (raw) {
    const un = app.unsignCookie(raw);
    if (un.valid) sid = un.value;
  }
  if (!sid) {
    sid = newSessionId();
    reply.setCookie(config.sessionCookie, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // loopback http only; never serve this off-box
      signed: true,
      maxAge: 60 * 60 * 12,
    });
  }
  req.sid = sid;
  ensureSession(sid);

  // CSRF: a cross-site page can POST to localhost, so require a same-origin
  // Origin header on every mutating request. The OAuth callback is a GET.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      reply.code(403).send({ error: 'cross-origin request refused' });
    }
  }
});

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  req.log.warn({ err, upstream: redact(err.upstream) }, 'request failed');
  reply.code(status).send({
    error: status === 500 ? 'internal error' : err.message,
    needsAuth: ['github_not_connected', 'jira_not_connected', 'jira_reauth_required'].includes(err.message),
  });
});

await app.register(authRoutes);
await app.register(jiraRoutes);
await app.register(githubRoutes);

app.get('/api/health', async () => ({ ok: true, ...configHealth() }));

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  await app.register(fstatic, { root: dist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
  );
}

const health = configHealth();
if (!health.ready) {
  app.log.warn(`missing env: ${health.missing.join(', ')} — copy .env.example to .env`);
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`jira-branch-forge on ${config.origin} (loopback only, tokens in memory)`);
