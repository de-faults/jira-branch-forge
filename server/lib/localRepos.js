import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';

/**
 * Discover git clones already on this machine and read their `origin` remote.
 *
 * Deliberately reads `.git/config` and `.git/HEAD` as plain files instead of
 * spawning `git` per directory: one filesystem walk, no subprocesses, and
 * nothing from the scanned tree is ever executed.
 *
 * Scanning is confined to REPO_SCAN_ROOTS, depth-capped, and never follows
 * symlinks — a symlinked directory cannot walk us out of the configured roots.
 */

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'target', '.next', '.venv',
  'venv', '__pycache__', '.cache', 'Library', 'AppData',
]);

export function scanRoots() {
  const repos = [];
  const seen = new Set();
  for (const root of config.repoScan.roots) {
    const abs = path.resolve(root.replace(/^~(?=$|\/)/, os.homedir()));
    if (!isDir(abs)) continue;
    walk(abs, 0, repos, seen);
  }
  return repos.sort((a, b) => b.mtime - a.mtime);
}

function walk(dir, depth, out, seen) {
  if (depth > config.repoScan.depth || out.length >= config.repoScan.max) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory is not an error worth failing the scan for
  }

  const gitEntry = entries.find((e) => e.name === '.git');
  if (gitEntry) {
    const repo = readRepo(dir, gitEntry);
    if (repo) {
      if (!seen.has(repo.path)) {
        seen.add(repo.path);
        out.push(repo);
      }
      return; // a usable repo is a leaf: do not descend into nested trees
    }
    // A .git with no usable GitHub origin is not a stopping point. A parent
    // directory that happens to be a repo itself must not hide the clones
    // sitting inside it.
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    walk(path.join(dir, e.name), depth + 1, out, seen);
  }
}

function readRepo(dir, gitEntry) {
  const gitDir = resolveGitDir(dir, gitEntry);
  if (!gitDir) return null;

  const origin = parseOrigin(readFile(path.join(gitDir, 'config')));
  if (!origin) return null;

  const parsed = parseRemoteUrl(origin);
  if (!parsed) return null;

  const host = config.github.host || 'github.com';
  if (parsed.host !== host) return null;
  if (config.github.orgs.length && !config.github.orgs.includes(parsed.owner)) return null;

  return {
    path: dir,
    name: path.basename(dir),
    owner: parsed.owner,
    repo: parsed.name,
    fullName: `${parsed.owner}/${parsed.name}`,
    host: parsed.host,
    remoteUrl: origin,
    currentBranch: readHead(gitDir),
    mtime: statMtime(path.join(gitDir, 'HEAD')) || statMtime(dir) || 0,
  };
}

/** Handles both a real .git directory and the `gitdir:` file used by worktrees. */
function resolveGitDir(dir, gitEntry) {
  const p = path.join(dir, '.git');
  if (gitEntry.isDirectory()) return p;
  const pointer = readFile(p);
  const m = pointer && /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!m) return null;
  const resolved = path.resolve(dir, m[1].trim());
  // A linked worktree's config lives in the main repo, two levels up.
  const main = path.resolve(resolved, '..', '..');
  if (isFile(path.join(main, 'config'))) return main;
  return isFile(path.join(resolved, 'config')) ? resolved : null;
}

function parseOrigin(cfg) {
  if (!cfg) return null;
  // Walk sections rather than regexing the whole file: a url line belonging to
  // some other remote must not be mistaken for origin's.
  let inOrigin = false;
  for (const raw of cfg.split('\n')) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url) return url[1].trim();
  }
  return null;
}

export function parseRemoteUrl(url) {
  if (!url) return null;
  let m = /^(?:https?:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) m = /^(?:ssh:\/\/)?(?:git@)([^/:]+)(?::\d+)?[:/](.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  const [, host, owner, name] = m;
  // Nested groups (GitLab style) are not valid GitHub owners; keep the last.
  return { host, owner: owner.split('/').pop(), name };
}

function readHead(gitDir) {
  const head = readFile(path.join(gitDir, 'HEAD'));
  if (!head) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return ref ? ref[1].trim() : `${head.trim().slice(0, 7)} (detached)`;
}

const readFile = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const statMtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
