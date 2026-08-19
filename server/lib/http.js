/** Thin fetch wrapper. Throws a shaped error so routes never leak raw bodies. */
export async function req(url, { token, tokenType = 'Bearer', headers = {}, ...init } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `${tokenType} ${token}`;
  if (init.body && typeof init.body !== 'string') {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, { ...init, headers: h });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(pickMessage(body) || `${res.status} ${res.statusText}`);
    err.statusCode = res.status;
    err.upstream = redact(body);
    throw err;
  }
  return body;
}

function pickMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 200);
  if (Array.isArray(body.errorMessages) && body.errorMessages.length) return body.errorMessages[0];
  if (body.errors && typeof body.errors === 'object') {
    const first = Object.values(body.errors)[0];
    if (typeof first === 'string') return first;
  }
  return body.message || body.error_description || body.error || null;
}

const SECRET_KEYS = /token|secret|authorization|cookie|password|code_verifier/i;

/** Defence in depth: strip anything credential-shaped before it can be logged. */
export function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}
