import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/** Card + repo -> branch. Base defaults to the repo's default branch. */
export function BranchForm({ issue, cloudId, onCreated, existing = [] }) {
  const [orgs, setOrgs] = useState([]);
  const [org, setOrg] = useState('');
  const [repoQuery, setRepoQuery] = useState('');
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState(null);
  const [meta, setMeta] = useState(null);
  const [base, setBase] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.orgs().then(setOrgs).catch(() => setOrgs([]));
  }, []);

  // Regenerate the name whenever the card changes, unless the user edited it.
  useEffect(() => {
    if (!issue) return;
    api
      .previewBranch({ key: issue.key, summary: issue.summary, issueType: issue.type })
      .then((r) => setBranch(r.branch))
      .catch(() => {});
    setResult(null);
    setErr('');
  }, [issue?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setTimeout(() => {
      api
        .repos({ org, q: repoQuery })
        .then((r) => setRepos(r.repos))
        .catch((e) => setErr(e.message));
    }, repoQuery ? 350 : 0);
    return () => clearTimeout(id);
  }, [org, repoQuery]);

  async function pickRepo(r) {
    setRepo(r);
    setMeta(null);
    setResult(null);
    try {
      const m = await api.branches(r.fullName);
      setMeta(m);
      setBase(m.defaultBranch);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function create() {
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const r = await api.createBranch({
        repo: repo.fullName,
        base,
        branch,
        issueKey: issue.key,
        cloudId,
      });
      setResult(r);
      onCreated?.();
    } catch (e) {
      setErr(e.payload?.url ? `${e.message} → ${e.payload.url}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  const canPush = meta?.permissions?.push;

  return (
    <div className="box">
      <div className="box-header">Create branch</div>
      <div className="box-body">
        {existing.length > 0 && (
          <div className="flash warn">
            Already forged for {issue.key}:{' '}
            {existing.map((l) => (
              <a key={l.id} href={l.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                {l.repo}:{l.branch}
              </a>
            ))}
          </div>
        )}
        {err && <div className="flash err">{err}</div>}

        <div className="field">
          <label>Organization</label>
          <select className="input" value={org} onChange={(e) => { setOrg(e.target.value); setRepo(null); }}>
            <option value="">My repositories</option>
            {orgs.map((o) => <option key={o.login} value={o.login}>{o.login}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Repository</label>
          <input
            className="input"
            placeholder="Filter repositories…"
            value={repoQuery}
            onChange={(e) => setRepoQuery(e.target.value)}
          />
          <div className="box" style={{ maxHeight: 180, overflowY: 'auto' }}>
            {repos.slice(0, 60).map((r) => (
              <div
                key={r.fullName}
                className={`box-row ${repo?.fullName === r.fullName ? 'selected' : ''}`}
                onClick={() => pickRepo(r)}
              >
                <span style={{ flex: 1 }}>{r.fullName}</span>
                {r.private && <span className="label">private</span>}
              </div>
            ))}
            {!repos.length && <div className="box-body muted">No repositories.</div>}
          </div>
        </div>

        {repo && (
          <>
            <div className="field">
              <label>Base branch</label>
              <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
                {(meta?.branches || []).map((b) => (
                  <option key={b.name} value={b.name}>{b.name}{b.protected ? ' (protected)' : ''}</option>
                ))}
              </select>
            </div>
            {meta && !canPush && (
              <div className="flash err">No push permission on {repo.fullName} — branch creation will be refused.</div>
            )}
          </>
        )}

        <div className="field">
          <label>Branch name</label>
          <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <div className="branch-preview">{branch || '—'}</div>
        </div>

        <button className="btn btn-primary" onClick={create} disabled={!repo || !branch || !base || busy || !canPush}>
          {busy ? 'Creating…' : 'Create branch'}
        </button>

        {result && (
          <div className="flash ok" style={{ marginTop: 12 }}>
            <div>
              Created <a href={result.url} target="_blank" rel="noreferrer">{result.branch}</a> from {result.base}
              {' '}<span className="mono-key">{String(result.sha).slice(0, 7)}</span>
            </div>
            <div className="branch-preview" style={{ marginTop: 8 }}>{result.checkout}</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => navigator.clipboard.writeText(result.checkout)}>
              Copy checkout command
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
