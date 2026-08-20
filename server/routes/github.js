import { config } from '../config.js';
import { ghApi } from '../lib/gh.js';
import { scanRoots } from '../lib/localRepos.js';
import { buildBranchName, sanitizeRef } from '../lib/branchName.js';
import {
  db, upsertRepo, insertBranchLink, listBranchLinks, recentBranchLinks,
  upsertLocalRepo, listLocalRepos, pruneLocalRepos, isFresh, markFresh,
} from '../db.js';

/**
 * Every call below runs through `gh api`. The CLI supplies the credential, so
 * no token ever enters this process — see server/lib/gh.js.
 */
const gh = (path, init) => ghApi(path, init);

export default async function githubRoutes(app) {
  app.get('/api/github/orgs', async (req) => {
    const orgs = await gh('/user/orgs?per_page=100');
    const allowed = config.github.orgs;
    return orgs
      .map((o) => ({ login: o.login, avatar: o.avatar_url }))
      .filter((o) => !allowed.length || allowed.includes(o.login));
  });

  /** Repo picker. Scoped to the corp org when GITHUB_ORGS is configured. */
  app.get('/api/github/repos', async (req) => {
    const { org, q = '', refresh } = req.query;
    if (org && config.github.orgs.length && !config.github.orgs.includes(org)) {
      throw Object.assign(new Error('org not allowed by GITHUB_ORGS'), { statusCode: 403 });
    }
    const cacheKey = `repos:${org || '@me'}`;
    if (!refresh && !q && isFresh(cacheKey, config.cacheTtlMs)) {
      const where = org ? 'WHERE owner = ?' : '';
      const rows = db
        .prepare(`SELECT full_name, owner, name, default_branch, private FROM gh_repos ${where} ORDER BY pushed_at DESC LIMIT 200`)
        .all(...(org ? [org] : []));
      return { cached: true, repos: rows.map(fromRow) };
    }

    let items;
    if (q) {
      const scope = org ? `org:${org} ` : '';
      const search = await gh(
        `/search/repositories?per_page=30&q=${encodeURIComponent(`${scope}${q} in:name fork:true`)}`,
      );
      items = search.items || [];
    } else if (org) {
      items = await gh(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed`);
    } else {
      items = await gh('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    }

    const now = Date.now();
    const repos = items.map((r) => ({
      fullName: r.full_name,
      owner: r.owner?.login,
      name: r.name,
      defaultBranch: r.default_branch,
      private: !!r.private,
      pushedAt: r.pushed_at,
    }));
    const tx = db.transaction((list) => {
      for (const r of list) {
        upsertRepo.run({
          full_name: r.fullName, owner: r.owner, name: r.name,
          default_branch: r.defaultBranch, private: r.private ? 1 : 0,
          pushed_at: r.pushedAt, updated_at: now,
        });
      }
    });
    tx(repos);
    if (!q) markFresh(cacheKey);
    return { cached: false, repos };
  });

  /**
   * Repos already cloned on this machine, keyed by their `origin` remote.
   * This is the default source for the picker: you almost always want the repo
   * you already have checked out, and it needs no API call at all.
   */
  app.get('/api/local/repos', async (req) => {
    const cacheKey = 'local:repos';
    if (!req.query.refresh && isFresh(cacheKey, config.cacheTtlMs)) {
      return { cached: true, roots: config.repoScan.roots, repos: listLocalRepos.all().map(fromLocalRow) };
    }
    const started = Date.now();
    const found = scanRoots();
    const tx = db.transaction((list) => {
      for (const r of list) {
        upsertLocalRepo.run({
          path: r.path, full_name: r.fullName, owner: r.owner, repo: r.repo,
          host: r.host, remote_url: r.remoteUrl, current_branch: r.currentBranch,
          updated_at: started,
        });
      }
      pruneLocalRepos.run(started); // clones that disappeared drop out of the cache
    });
    tx(found);
    markFresh(cacheKey);
    return {
      cached: false,
      roots: config.repoScan.roots,
      scannedMs: Date.now() - started,
      repos: found.map((r) => ({
        path: r.path, fullName: r.fullName, owner: r.owner, name: r.repo,
        currentBranch: r.currentBranch, remoteUrl: r.remoteUrl,
      })),
    };
  });

  app.get('/api/github/repos/:owner/:repo/branches', async (req) => {
    const { owner, repo } = req.params;
    const [meta, branches] = await Promise.all([
      gh(`/repos/${enc(owner)}/${enc(repo)}`),
      gh(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`),
    ]);
    return {
      defaultBranch: meta.default_branch,
      permissions: {
        push: !!meta.permissions?.push,
        admin: !!meta.permissions?.admin,
      },
      branches: branches.map((b) => ({ name: b.name, sha: b.commit?.sha, protected: !!b.protected })),
    };
  });

  app.post('/api/github/branch/preview', async (req) => {
    const { key, summary, issueType, template } = req.body || {};
    return { branch: buildBranchName({ key, summary, issueType, template: template || config.branchTemplate }) };
  });

  /** The whole point of the app: card + repo -> new ref off a chosen base. */
  app.post('/api/github/branch', async (req, reply) => {
    const { repo, base, branch, issueKey, cloudId, localPath } = req.body || {};
    if (!repo || !branch) return reply.code(400).send({ error: 'repo and branch are required' });
    const [owner, name] = String(repo).split('/');
    if (!owner || !name) return reply.code(400).send({ error: 'repo must be owner/name' });
    if (config.github.orgs.length && !config.github.orgs.includes(owner)) {
      return reply.code(403).send({ error: `owner ${owner} is not in GITHUB_ORGS` });
    }
    const ref = sanitizeRef(branch);

    const meta = await gh(`/repos/${enc(owner)}/${enc(name)}`);
    if (!meta.permissions?.push) {
      return reply.code(403).send({ error: `No push permission on ${repo}.` });
    }
    const baseRef = base || meta.default_branch;

    const existing = await gh(`/repos/${enc(owner)}/${enc(name)}/git/ref/heads/${encodeURIComponent(ref)}`).catch(
      (e) => (e.statusCode === 404 ? null : Promise.reject(e)),
    );
    if (existing) {
      return reply.code(409).send({
        error: `Branch ${ref} already exists.`,
        url: `${meta.html_url}/tree/${ref}`,
      });
    }

    const baseInfo = await gh(`/repos/${enc(owner)}/${enc(name)}/git/ref/heads/${encodeURIComponent(baseRef)}`);
    const created = await gh(`/repos/${enc(owner)}/${enc(name)}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${ref}`, sha: baseInfo.object.sha },
    });

    const url = `${meta.html_url}/tree/${ref}`;
    // Only trust a local path that the scanner itself reported for this repo.
    const known = localPath ? listLocalRepos.all().find((r) => r.path === localPath) : null;
    const verifiedPath = known && known.full_name === repo ? known.path : null;

    insertBranchLink.run({
      issue_key: issueKey || null, cloud_id: cloudId || null, repo, branch: ref,
      base: baseRef, sha: created.object?.sha, url, local_path: verifiedPath,
      created_at: Date.now(),
    });

    return {
      ok: true,
      branch: ref,
      base: baseRef,
      sha: created.object?.sha,
      url,
      localPath: verifiedPath,
      checkout: verifiedPath
        ? `git -C ${verifiedPath} fetch origin ${ref} && git -C ${verifiedPath} switch ${ref}`
        : `git fetch origin ${ref} && git switch ${ref}`,
    };
  });

  app.get('/api/branch-links', async (req) =>
    req.query.issueKey ? listBranchLinks.all(req.query.issueKey) : recentBranchLinks.all(20),
  );
}

const enc = encodeURIComponent;
const fromLocalRow = (r) => ({
  path: r.path,
  fullName: r.full_name,
  owner: r.owner,
  name: r.repo,
  currentBranch: r.current_branch,
  remoteUrl: r.remote_url,
});
const fromRow = (r) => ({
  fullName: r.full_name,
  owner: r.owner,
  name: r.name,
  defaultBranch: r.default_branch,
  private: !!r.private,
});
