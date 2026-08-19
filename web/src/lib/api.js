async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.needsAuth = data.needsAuth;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  session: () => call('/api/session'),
  logout: () => call('/api/auth/logout', { method: 'POST' }),

  ghAccounts: () => call('/api/github/accounts'),
  jiraStart: () => call('/api/auth/jira/start', { method: 'POST' }),

  sites: () => call('/api/jira/sites'),
  projects: (cloudId, refresh) =>
    call(`/api/jira/sites/${cloudId}/projects${refresh ? '?refresh=1' : ''}`),
  issues: (cloudId, params) =>
    call(`/api/jira/sites/${cloudId}/issues?${new URLSearchParams(params)}`),
  issue: (cloudId, key) => call(`/api/jira/sites/${cloudId}/issues/${key}`),
  transition: (cloudId, key, transitionId) =>
    call(`/api/jira/sites/${cloudId}/issues/${key}/transition`, { method: 'POST', body: { transitionId } }),
  assignToMe: (cloudId, key) =>
    call(`/api/jira/sites/${cloudId}/issues/${key}/assign`, { method: 'POST', body: { accountId: 'me' } }),

  orgs: () => call('/api/github/orgs'),
  repos: (params) => call(`/api/github/repos?${new URLSearchParams(params)}`),
  branches: (fullName) => call(`/api/github/repos/${fullName}/branches`),
  previewBranch: (body) => call('/api/github/branch/preview', { method: 'POST', body }),
  createBranch: (body) => call('/api/github/branch', { method: 'POST', body }),
  links: (issueKey) => call(`/api/branch-links${issueKey ? `?issueKey=${issueKey}` : ''}`),
};
