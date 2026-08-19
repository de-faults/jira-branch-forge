import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { Connect } from './components/Connect.jsx';
import { IssueList } from './components/IssueList.jsx';
import { IssueDetail } from './components/IssueDetail.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [sites, setSites] = useState([]);
  const [cloudId, setCloudId] = useState('');
  const [issueKey, setIssueKey] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [err, setErr] = useState('');

  const refreshSession = useCallback(() => {
    api.session().then(setSession).catch((e) => setErr(e.message));
  }, []);

  useEffect(refreshSession, [refreshSession]);

  useEffect(() => {
    if (!session?.jira?.connected) return;
    api
      .sites()
      .then((s) => {
        setSites(s);
        setCloudId((prev) => prev || s[0]?.cloudId || '');
      })
      .catch((e) => setErr(e.message));
  }, [session?.jira?.connected]);

  const connected = session?.github?.connected && session?.jira?.connected;
  const site = sites.find((s) => s.cloudId === cloudId);

  return (
    <>
      <header className="header">
        <span className="brand">
          <svg height="24" viewBox="0 0 16 16" width="24" fill="currentColor" aria-hidden="true">
            <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
          </svg>
          Branch Forge
        </span>
        <span className="label">local only · 127.0.0.1</span>
        <span className="label ok">github via gh cli</span>
        <span className="label ok">jira token in memory</span>
        <span className="spacer" />
        {sites.length > 1 && (
          <select className="input" style={{ width: 220 }} value={cloudId} onChange={(e) => { setCloudId(e.target.value); setIssueKey(''); }}>
            {sites.map((s) => <option key={s.cloudId} value={s.cloudId}>{s.name}</option>)}
          </select>
        )}
        {session?.github?.connected && <img className="avatar" src={session.github.avatar} alt="" />}
        {connected && (
          <button
            className="btn btn-sm btn-danger"
            title="Drops the in-memory Jira token. Your gh CLI login is untouched."
            onClick={() => api.logout().then(refreshSession)}
          >
            Disconnect Jira
          </button>
        )}
      </header>

      {err && <div className="box-body"><div className="flash err">{err}</div></div>}

      {session?.config && !session.config.ready && (
        <div style={{ padding: '16px 16px 0' }}>
          <div className="flash warn">
            Missing env: {session.config.missing.join(', ')} — copy <code>.env.example</code> to <code>.env</code> and restart.
          </div>
        </div>
      )}

      {!connected ? (
        <div style={{ maxWidth: 520, margin: '48px auto' }}>
          <Connect session={session} onChange={refreshSession} />
          <p className="subtle" style={{ marginTop: 16 }}>
            This service binds to 127.0.0.1 only. GitHub calls are executed by the <code>gh</code>{' '}
            CLI, so no GitHub token ever enters this process. The Jira token lives in process
            memory alone — never written to SQLite, never logged, never sent to this page — so
            restarting the server disconnects Jira.
          </p>
        </div>
      ) : (
        <div className="layout">
          <IssueList
            key={`${cloudId}-${reloadTick}`}
            cloudId={cloudId}
            selectedKey={issueKey}
            onPick={setIssueKey}
          />
          <IssueDetail
            cloudId={cloudId}
            site={site}
            issueKey={issueKey}
            onIssueChanged={(nextKey) => {
              if (typeof nextKey === 'string') setIssueKey(nextKey);
              setReloadTick((t) => t + 1);
            }}
          />
        </div>
      )}
    </>
  );
}
