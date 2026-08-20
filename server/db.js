import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data');
fs.mkdirSync(dir, { recursive: true });

export const db = new Database(path.join(dir, 'cache.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Cache only. Every column here is data the user could read anyway from Jira
 * or GitHub with their own eyes. No token, no refresh token, no cookie, no
 * client secret ever reaches this file — see server/secrets.js.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS jira_sites (
  cloud_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  avatar     TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jira_projects (
  cloud_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  avatar     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cloud_id, key)
);
CREATE TABLE IF NOT EXISTS jira_issues (
  cloud_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  project_key TEXT,
  summary     TEXT,
  status      TEXT,
  status_cat  TEXT,
  issue_type  TEXT,
  assignee    TEXT,
  parent_key  TEXT,
  is_subtask  INTEGER DEFAULT 0,
  payload     TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (cloud_id, key)
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON jira_issues (cloud_id, project_key);
CREATE TABLE IF NOT EXISTS gh_repos (
  full_name      TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_branch TEXT,
  private        INTEGER,
  pushed_at      TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_repos (
  path           TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  host           TEXT,
  remote_url     TEXT,
  current_branch TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_full ON local_repos (full_name);
CREATE TABLE IF NOT EXISTS branch_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key  TEXT NOT NULL,
  cloud_id   TEXT,
  repo       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  base       TEXT NOT NULL,
  sha        TEXT,
  url        TEXT,
  local_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_issue ON branch_links (issue_key);
CREATE TABLE IF NOT EXISTS cache_meta (
  key        TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
`);

// Additive migrations for databases created by an earlier version.
for (const [table, column, decl] of [['branch_links', 'local_path', 'TEXT']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

const touchStmt = db.prepare(
  'INSERT INTO cache_meta (key, updated_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at',
);
const readStmt = db.prepare('SELECT updated_at FROM cache_meta WHERE key = ?');

export function markFresh(key) {
  touchStmt.run(key, Date.now());
}

export function isFresh(key, ttlMs) {
  const row = readStmt.get(key);
  return !!row && Date.now() - row.updated_at < ttlMs;
}

export const upsertSite = db.prepare(`
  INSERT INTO jira_sites (cloud_id, name, url, avatar, updated_at)
  VALUES (@cloud_id, @name, @url, @avatar, @updated_at)
  ON CONFLICT(cloud_id) DO UPDATE SET
    name=excluded.name, url=excluded.url, avatar=excluded.avatar, updated_at=excluded.updated_at`);

export const upsertProject = db.prepare(`
  INSERT INTO jira_projects (cloud_id, key, name, avatar, updated_at)
  VALUES (@cloud_id, @key, @name, @avatar, @updated_at)
  ON CONFLICT(cloud_id, key) DO UPDATE SET
    name=excluded.name, avatar=excluded.avatar, updated_at=excluded.updated_at`);

export const upsertIssue = db.prepare(`
  INSERT INTO jira_issues (cloud_id, key, project_key, summary, status, status_cat, issue_type,
                           assignee, parent_key, is_subtask, payload, updated_at)
  VALUES (@cloud_id, @key, @project_key, @summary, @status, @status_cat, @issue_type,
          @assignee, @parent_key, @is_subtask, @payload, @updated_at)
  ON CONFLICT(cloud_id, key) DO UPDATE SET
    project_key=excluded.project_key, summary=excluded.summary, status=excluded.status,
    status_cat=excluded.status_cat, issue_type=excluded.issue_type, assignee=excluded.assignee,
    parent_key=excluded.parent_key, is_subtask=excluded.is_subtask, payload=excluded.payload,
    updated_at=excluded.updated_at`);

export const upsertRepo = db.prepare(`
  INSERT INTO gh_repos (full_name, owner, name, default_branch, private, pushed_at, updated_at)
  VALUES (@full_name, @owner, @name, @default_branch, @private, @pushed_at, @updated_at)
  ON CONFLICT(full_name) DO UPDATE SET
    default_branch=excluded.default_branch, private=excluded.private,
    pushed_at=excluded.pushed_at, updated_at=excluded.updated_at`);

export const upsertLocalRepo = db.prepare(`
  INSERT INTO local_repos (path, full_name, owner, repo, host, remote_url, current_branch, updated_at)
  VALUES (@path, @full_name, @owner, @repo, @host, @remote_url, @current_branch, @updated_at)
  ON CONFLICT(path) DO UPDATE SET
    full_name=excluded.full_name, owner=excluded.owner, repo=excluded.repo,
    host=excluded.host, remote_url=excluded.remote_url,
    current_branch=excluded.current_branch, updated_at=excluded.updated_at`);

export const listLocalRepos = db.prepare('SELECT * FROM local_repos ORDER BY updated_at DESC');
export const pruneLocalRepos = db.prepare('DELETE FROM local_repos WHERE updated_at < ?');

export const insertBranchLink = db.prepare(`
  INSERT INTO branch_links (issue_key, cloud_id, repo, branch, base, sha, url, local_path, created_at)
  VALUES (@issue_key, @cloud_id, @repo, @branch, @base, @sha, @url, @local_path, @created_at)`);

export const listBranchLinks = db.prepare(
  'SELECT * FROM branch_links WHERE issue_key = ? ORDER BY created_at DESC',
);
export const recentBranchLinks = db.prepare(
  'SELECT * FROM branch_links ORDER BY created_at DESC LIMIT ?',
);
