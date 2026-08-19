import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const FILTERS = [
  ['open', 'Open'],
  ['mine', 'Assigned to me'],
  ['unassigned', 'Unassigned'],
  ['others', "Someone else's"],
  ['all', 'All'],
];

export function IssueList({ cloudId, selectedKey, onPick }) {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState('');
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!cloudId) return;
    api.projects(cloudId).then((r) => setProjects(r.projects)).catch((e) => setErr(e.message));
  }, [cloudId]);

  useEffect(() => {
    if (!cloudId) return;
    const id = setTimeout(load, q ? 400 : 0); // debounce typing only
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudId, project, filter, q]);

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const r = await api.issues(cloudId, { project, filter, q, limit: 50 });
      setIssues(r.issues);
    } catch (e) {
      setErr(e.message);
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="box">
      <div className="box-header">
        Cards {loading && <span className="spin" />}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-sm btn-invisible" onClick={load}>Refresh</button>
      </div>
      <div className="box-body" style={{ paddingBottom: 8 }}>
        <div className="field">
          <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>{p.key} — {p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <input className="input" placeholder="Search summary…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${filter === id ? 'btn-primary' : 'btn-invisible'}`}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="box-body"><div className="flash err">{err}</div></div>}
      <div className="list-scroll">
        {issues.map((i) => (
          <div
            key={i.key}
            className={`box-row ${selectedKey === i.key ? 'selected' : ''}`}
            onClick={() => onPick(i.key)}
          >
            {i.typeIcon && <img src={i.typeIcon} alt={i.type} width="16" height="16" style={{ marginTop: 3 }} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="mono-key">{i.key}</span>
                <StatusLabel status={i.status} cat={i.statusCategory} />
                {i.isSubtask && <span className="label">subtask</span>}
              </div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.summary}</div>
              <div className="subtle">
                {i.assignee ? i.assignee.name : 'Unassigned'}
                {i.parent && ` · parent ${i.parent.key}`}
              </div>
            </div>
          </div>
        ))}
        {!loading && !issues.length && <div className="box-body muted">No cards match.</div>}
      </div>
    </div>
  );
}

export function StatusLabel({ status, cat }) {
  return <span className={`label ${cat || 'todo'}`}>{status}</span>;
}
