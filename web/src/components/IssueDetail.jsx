import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { StatusLabel } from './IssueList.jsx';
import { BranchForm } from './BranchForm.jsx';

export function IssueDetail({ cloudId, site, issueKey, onIssueChanged }) {
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState(null);
  const [links, setLinks] = useState([]);

  useEffect(() => {
    if (!issueKey) return setIssue(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudId, issueKey]);

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const [i, l] = await Promise.all([api.issue(cloudId, issueKey), api.links(issueKey)]);
      setIssue(i);
      setLinks(l);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function transition(id) {
    setFlash(null);
    try {
      const r = await api.transition(cloudId, issueKey, id);
      setFlash({ kind: 'ok', text: `Status → ${r.status}` });
      await load();
      onIssueChanged?.();
    } catch (e) {
      setFlash({ kind: 'err', text: e.message });
    }
  }

  async function claim() {
    setFlash(null);
    try {
      await api.assignToMe(cloudId, issueKey);
      setFlash({ kind: 'ok', text: 'Assigned to you' });
      await load();
      onIssueChanged?.();
    } catch (e) {
      setFlash({ kind: 'err', text: e.message });
    }
  }

  if (!issueKey) {
    return (
      <div className="box">
        <div className="box-body muted">Pick a card on the left to see its detail and forge a branch.</div>
      </div>
    );
  }
  if (loading && !issue) return <div className="box"><div className="box-body"><span className="spin" /> Loading…</div></div>;
  if (err) return <div className="box"><div className="box-body"><div className="flash err">{err}</div></div></div>;
  if (!issue) return null;

  const browseUrl = site?.url ? `${site.url}/browse/${issue.key}` : null;
  const canTransition = issue.can?.TRANSITION_ISSUES;
  const canAssign = issue.can?.ASSIGN_ISSUES;
  const notMine = !issue.assignee;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="box">
        <div className="box-header">
          <span className="mono-key">{issue.key}</span>
          <StatusLabel status={issue.status} cat={issue.statusCategory} />
          <span style={{ flex: 1 }} />
          {browseUrl && <a className="btn btn-sm" href={browseUrl} target="_blank" rel="noreferrer">Open in Jira</a>}
        </div>
        <div className="box-body">
          {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}
          <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{issue.summary}</h2>
          <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
            <span className="label">{issue.type}</span>
            {issue.priority && <span className="label">{issue.priority}</span>}
            {issue.parent && <span className="label">parent {issue.parent.key}</span>}
            {issue.labels.map((l) => <span className="label" key={l}>{l}</span>)}
          </div>

          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <span className="subtle">Assignee:</span>
            {issue.assignee ? (
              <span className="row" style={{ gap: 4 }}>
                {issue.assignee.avatar && <img className="avatar" src={issue.assignee.avatar} alt="" />}
                {issue.assignee.name}
              </span>
            ) : (
              <span className="muted">Unassigned</span>
            )}
            <button className="btn btn-sm" onClick={claim} disabled={!canAssign} title={canAssign ? '' : 'ASSIGN_ISSUES permission missing'}>
              Assign to me
            </button>
          </div>

          {/* Picking a card that is not yours is allowed; Jira permissions
              decide what you can actually do with it. Show that up front. */}
          <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
            <Perm ok={issue.can?.TRANSITION_ISSUES} label="transition" />
            <Perm ok={issue.can?.EDIT_ISSUES} label="edit" />
            <Perm ok={issue.can?.ASSIGN_ISSUES} label="assign" />
            <Perm ok={issue.can?.ADD_COMMENTS} label="comment" />
            {notMine && <span className="label warn">not assigned to you</span>}
          </div>

          <div className="field">
            <label>Change status</label>
            <div className="row wrap" style={{ gap: 6 }}>
              {issue.transitions.length === 0 && <span className="muted">No transitions available.</span>}
              {issue.transitions.map((t) => (
                <button
                  key={t.id}
                  className="btn btn-sm"
                  disabled={!canTransition}
                  title={canTransition ? `→ ${t.to}` : 'TRANSITION_ISSUES permission missing'}
                  onClick={() => transition(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          {issue.description && <div className="desc">{issue.description}</div>}
        </div>
      </div>

      {issue.subtasks.length > 0 && (
        <div className="box">
          <div className="box-header">Subtasks ({issue.subtasks.length})</div>
          {issue.subtasks.map((s) => (
            <div className="box-row" key={s.key} onClick={() => onIssueChanged?.(s.key)}>
              <span className="mono-key">{s.key}</span>
              <span style={{ flex: 1 }}>{s.summary}</span>
              <StatusLabel status={s.status} cat={s.statusCategory} />
            </div>
          ))}
        </div>
      )}

      <BranchForm issue={issue} cloudId={cloudId} onCreated={load} existing={links} />
    </div>
  );
}

function Perm({ ok, label }) {
  return <span className={`label ${ok ? 'ok' : 'err'}`}>{ok ? '✓' : '✗'} {label}</span>;
}
