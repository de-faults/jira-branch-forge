import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Neither half of this screen ever accepts a token.
 *  - GitHub: delegated to the `gh` CLI, which holds its own credential.
 *  - Jira: Atlassian's own consent screen via OAuth 2.0 + PKCE.
 */
export function Connect({ session, onChange }) {
  return (
    <div className="box">
      <div className="box-header">Connections</div>
      <div className="box-body">
        <GithubStatus session={session} onChange={onChange} />
        <hr style={{ border: 0, borderTop: '1px solid var(--border-muted)', margin: '16px 0' }} />
        <JiraConnect session={session} onChange={onChange} />
      </div>
    </div>
  );
}

const LOGIN_CMD = 'gh auth login --scopes "repo,read:org"';

function GithubStatus({ session, onChange }) {
  const gh = session?.github;
  const [accounts, setAccounts] = useState([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (gh?.connected) api.ghAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, [gh?.connected, gh?.login]);

  async function recheck() {
    setChecking(true);
    await onChange();
    setChecking(false);
  }

  if (gh?.connected) {
    return (
      <div>
        <div className="row">
          {gh.avatar && <img className="avatar" src={gh.avatar} alt="" />}
          <div style={{ flex: 1 }}>
            <div>
              <b>{gh.login}</b> <span className="label ok">gh CLI</span>
              {gh.host !== 'github.com' && <span className="label"> {gh.host}</span>}
            </div>
            <div className="subtle">scopes: {gh.scopes?.join(', ') || 'fine-grained token'}</div>
          </div>
        </div>
        {gh.missingScopes?.length > 0 && (
          <div className="flash warn" style={{ marginTop: 8 }}>
            Missing scope{gh.missingScopes.length > 1 ? 's' : ''}: <b>{gh.missingScopes.join(', ')}</b>.
            Creating branches on private repos will fail. Run:
            <div className="branch-preview" style={{ marginTop: 6 }}>
              gh auth refresh --scopes "{gh.missingScopes.join(',')}"
            </div>
          </div>
        )}
        {accounts.length > 1 && (
          <div className="subtle" style={{ marginTop: 6 }}>
            Other gh accounts: {accounts.filter((a) => !a.active).map((a) => a.login).join(', ')} — switch with{' '}
            <code>gh auth switch</code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>GitHub</b>
        <span className="label">via gh CLI</span>
      </div>
      <div className="flash warn">
        {gh?.reason || 'gh is not authenticated.'}
      </div>
      <p className="subtle" style={{ marginTop: 0 }}>
        Log in from your terminal — <code>gh auth login</code> needs a TTY, so this app will not
        run it for you (and never asks you for a token):
      </p>
      <div className="branch-preview">{LOGIN_CMD}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => navigator.clipboard.writeText(LOGIN_CMD)}>Copy command</button>
        <button className="btn btn-primary" onClick={recheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

function JiraConnect({ session, onChange }) {
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState(false);

  async function start() {
    setErr('');
    try {
      const { authorizeUrl } = await api.jiraStart();
      const win = window.open(authorizeUrl, 'jira-oauth', 'width=620,height=760');
      setWaiting(true);
      // The callback page closes itself; poll the session until it lands.
      const id = setInterval(async () => {
        const s = await api.session().catch(() => null);
        if (s?.jira?.connected || win?.closed) {
          clearInterval(id);
          setWaiting(false);
          onChange();
        }
      }, 1500);
      setTimeout(() => clearInterval(id), 5 * 60 * 1000);
    } catch (e) {
      setErr(e.message);
      setWaiting(false);
    }
  }

  if (session?.jira?.connected) {
    return (
      <div className="row">
        {session.jira.avatar && <img className="avatar" src={session.jira.avatar} alt="" />}
        <div>
          <div><b>{session.jira.name || session.jira.account}</b> <span className="label ok">Jira connected</span></div>
          <div className="subtle">token expires in {Math.round((session.jira.expiresInSec || 0) / 60)} min</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>Jira</b>
        <span className="label">OAuth 2.0 · PKCE</span>
      </div>
      {err && <div className="flash err">{err}</div>}
      <button className="btn btn-primary" onClick={start} disabled={waiting}>
        {waiting ? 'Waiting for consent…' : 'Connect Jira'}
      </button>
    </div>
  );
}
