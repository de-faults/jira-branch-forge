import { config } from '../config.js';
import { jiraFetch } from '../auth/jira.js';
import { db, upsertSite, upsertProject, upsertIssue, isFresh, markFresh } from '../db.js';

const PERMISSIONS = [
  'BROWSE_PROJECTS',
  'TRANSITION_ISSUES',
  'EDIT_ISSUES',
  'ASSIGN_ISSUES',
  'ASSIGNABLE_USER',
  'ADD_COMMENTS',
];

/** Atlassian Document Format -> plain text. Good enough for a detail pane. */
function adfToText(node, out = []) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') out.push(node.text || '');
  if (node.type === 'hardBreak' || node.type === 'paragraph') out.push('\n');
  if (node.type === 'listItem') out.push('\n• ');
  if (node.type === 'codeBlock') out.push('\n');
  (node.content || []).forEach((c) => adfToText(c, out));
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

const shapeIssue = (i) => ({
  key: i.key,
  id: i.id,
  summary: i.fields?.summary || '',
  status: i.fields?.status?.name || '',
  statusCategory: i.fields?.status?.statusCategory?.key || '',
  type: i.fields?.issuetype?.name || '',
  typeIcon: i.fields?.issuetype?.iconUrl || '',
  isSubtask: !!i.fields?.issuetype?.subtask,
  priority: i.fields?.priority?.name || '',
  assignee: i.fields?.assignee
    ? {
        accountId: i.fields.assignee.accountId,
        name: i.fields.assignee.displayName,
        avatar: i.fields.assignee.avatarUrls?.['24x24'],
      }
    : null,
  reporter: i.fields?.reporter?.displayName || '',
  parent: i.fields?.parent ? { key: i.fields.parent.key, summary: i.fields.parent.fields?.summary } : null,
  project: i.fields?.project ? { key: i.fields.project.key, name: i.fields.project.name } : null,
  labels: i.fields?.labels || [],
  updated: i.fields?.updated,
});

export default async function jiraRoutes(app) {
  // Jira "groups" = the Atlassian sites this account can reach.
  app.get('/api/jira/sites', async (req) => {
    const rows = await jiraFetch(req.sid, null, '/oauth/token/accessible-resources');
    const now = Date.now();
    const sites = rows
      .filter((r) => (r.scopes || []).some((s) => s.startsWith('read:jira')))
      .map((r) => ({ cloudId: r.id, name: r.name, url: r.url, avatar: r.avatarUrl }));
    const tx = db.transaction((list) => {
      for (const s of list) {
        upsertSite.run({ cloud_id: s.cloudId, name: s.name, url: s.url, avatar: s.avatar, updated_at: now });
      }
    });
    tx(sites);
    return sites;
  });

  app.get('/api/jira/sites/:cloudId/projects', async (req) => {
    const { cloudId } = req.params;
    const cacheKey = `projects:${cloudId}`;
    if (!req.query.refresh && isFresh(cacheKey, config.cacheTtlMs)) {
      return {
        cached: true,
        projects: db
          .prepare('SELECT key, name, avatar FROM jira_projects WHERE cloud_id = ? ORDER BY key')
          .all(cloudId),
      };
    }
    const out = [];
    let startAt = 0;
    for (;;) {
      const page = await jiraFetch(
        req.sid,
        cloudId,
        `/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=key`,
      );
      out.push(...(page.values || []));
      if (page.isLast || out.length >= (page.total ?? out.length)) break;
      startAt += 50;
      if (startAt > 1000) break;
    }
    const now = Date.now();
    const projects = out.map((p) => ({ key: p.key, name: p.name, avatar: p.avatarUrls?.['24x24'] || null }));
    const tx = db.transaction((list) => {
      for (const p of list) {
        upsertProject.run({ cloud_id: cloudId, key: p.key, name: p.name, avatar: p.avatar, updated_at: now });
      }
    });
    tx(projects);
    markFresh(cacheKey);
    return { cached: false, projects };
  });

  /**
   * Issue search. `filter` covers the common cases including cards that are
   * NOT assigned to me — picking someone else's or nobody's card is a first
   * class flow here, permissions decide what you may then do with it.
   */
  app.get('/api/jira/sites/:cloudId/issues', async (req) => {
    const { cloudId } = req.params;
    const { project, filter = 'open', q = '', jql: rawJql = '' } = req.query;
    const clauses = [];
    if (project) clauses.push(`project = ${quote(project)}`);
    if (filter === 'mine') clauses.push('assignee = currentUser()');
    if (filter === 'unassigned') clauses.push('assignee IS EMPTY');
    if (filter === 'others') clauses.push('assignee != currentUser() AND assignee IS NOT EMPTY');
    if (filter !== 'all') clauses.push('statusCategory != Done');
    if (q) clauses.push(`(summary ~ ${quote(`${q}*`)} OR text ~ ${quote(`${q}*`)})`);
    const jql = (rawJql || clauses.join(' AND ') || 'order by updated desc').concat(
      /order\s+by/i.test(rawJql || clauses.join(' ')) ? '' : ' ORDER BY updated DESC',
    );

    const page = await jiraFetch(req.sid, cloudId, '/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql,
        maxResults: Number(req.query.limit) || 50,
        fields: [
          'summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority',
          'parent', 'project', 'labels', 'updated',
        ],
      },
    });

    const issues = (page.issues || []).map(shapeIssue);
    const now = Date.now();
    const tx = db.transaction((list) => {
      for (const i of list) {
        upsertIssue.run({
          cloud_id: cloudId, key: i.key, project_key: i.project?.key || null,
          summary: i.summary, status: i.status, status_cat: i.statusCategory,
          issue_type: i.type, assignee: i.assignee?.name || null,
          parent_key: i.parent?.key || null, is_subtask: i.isSubtask ? 1 : 0,
          payload: JSON.stringify(i), updated_at: now,
        });
      }
    });
    tx(issues);
    return { jql, issues };
  });

  app.get('/api/jira/sites/:cloudId/issues/:key', async (req) => {
    const { cloudId, key } = req.params;
    const issue = await jiraFetch(
      req.sid,
      cloudId,
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,assignee,reporter,priority,parent,project,labels,updated,description,subtasks,issuelinks`,
    );

    // Permissions and transitions are fetched together: the UI must be able to
    // grey out actions this account cannot perform on a card it does not own.
    const [perms, trans] = await Promise.all([
      jiraFetch(
        req.sid,
        cloudId,
        `/rest/api/3/mypermissions?issueKey=${encodeURIComponent(key)}&permissions=${PERMISSIONS.join(',')}`,
      ).catch(() => ({ permissions: {} })),
      jiraFetch(req.sid, cloudId, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`).catch(() => ({
        transitions: [],
      })),
    ]);

    const can = {};
    for (const p of PERMISSIONS) can[p] = !!perms.permissions?.[p]?.havePermission;

    const subtasks = (issue.fields?.subtasks || []).map((s) => ({
      key: s.key,
      summary: s.fields?.summary,
      status: s.fields?.status?.name,
      statusCategory: s.fields?.status?.statusCategory?.key,
      type: s.fields?.issuetype?.name,
    }));

    return {
      ...shapeIssue(issue),
      description: adfToText(issue.fields?.description),
      subtasks,
      transitions: (trans.transitions || []).map((t) => ({
        id: t.id,
        name: t.name,
        to: t.to?.name,
        toCategory: t.to?.statusCategory?.key,
      })),
      can,
      browseUrl: null,
    };
  });

  app.post('/api/jira/sites/:cloudId/issues/:key/transition', async (req, reply) => {
    const { cloudId, key } = req.params;
    const { transitionId } = req.body || {};
    if (!transitionId) return reply.code(400).send({ error: 'transitionId required' });
    await jiraFetch(req.sid, cloudId, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: String(transitionId) } },
    });
    const fresh = await jiraFetch(
      req.sid,
      cloudId,
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`,
    );
    return { ok: true, status: fresh.fields?.status?.name, statusCategory: fresh.fields?.status?.statusCategory?.key };
  });

  /** Claim a card that is not yours. Fails loudly if Jira says you may not. */
  app.post('/api/jira/sites/:cloudId/issues/:key/assign', async (req, reply) => {
    const { cloudId, key } = req.params;
    const { accountId } = req.body || {};
    let target = accountId;
    if (!target || target === 'me') {
      const me = await jiraFetch(req.sid, cloudId, '/rest/api/3/myself');
      target = me.accountId;
    }
    try {
      await jiraFetch(req.sid, cloudId, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
        method: 'PUT',
        body: { accountId: target },
      });
    } catch (err) {
      if (err.statusCode === 403 || err.statusCode === 401) {
        return reply.code(403).send({ error: 'You do not have permission to assign this issue.' });
      }
      throw err;
    }
    return { ok: true, accountId: target };
  });
}

/** JQL string literal escaping — user input never lands unquoted in a query. */
function quote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
