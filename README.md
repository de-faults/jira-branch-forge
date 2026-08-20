# Branch Forge

Local-only service. Pick a Jira card → read its detail and subtasks → pick a repo
in your corp GitHub org → create the branch. GitHub Primer theme, dark by default.

## Security model

The design constraint was *never hold a typed-in token*, so:

| Concern | How it is handled |
|---|---|
| GitHub auth | Delegated to the **`gh` CLI**. Every GitHub call is `gh api …` spawned with an argv array and no shell; `gh` injects its own credential. This process never holds, reads, or stores a GitHub token — there is no client id, no secret, and no token field in the UI. |
| Jira auth | OAuth 2.0 3LO with PKCE (S256), loopback redirect, single-use `state` compared timing-safely. |
| Token storage | Jira only, **process memory only** (`server/secrets.js`). Held in a private class field; the only exit is `use(fn)` — there is no getter to accidentally serialise. `toJSON`/`toString`/inspect all return `[redacted]`. GitHub has nothing to store. |
| SQLite | Cache of *non-secret* data only: sites, projects, issues, repos, branch history. No credential column exists. |
| Restart | Cookie signing secret is regenerated each boot, so a restart invalidates every session — matching the fact that the Jira token is already gone. The `gh` login is machine-level and survives. |
| Network | Binds `127.0.0.1` only, API and Vite dev server both. `trustProxy: false`. |
| CSRF | Every mutating request must carry a same-origin `Origin` header (a hostile page *can* reach localhost; this stops it). Session cookie is signed, `httpOnly`, `SameSite=Lax`. |
| Logging | Pino serialisers pinned to method/url/status; `authorization`, `cookie`, and any `*token*`/`*secret*` key redacted before an upstream error body can be logged. |
| Repo scope | `GITHUB_ORGS` allowlists which owners the picker and the branch-create endpoint will touch. |
| Filesystem scan | Confined to `REPO_SCAN_ROOTS`, depth- and count-capped, never follows symlinks, and reads `.git/config` / `.git/HEAD` as plain files — no `git` subprocess is spawned per clone, so nothing in a scanned tree is ever executed. A `localPath` sent by the browser is only honoured if the scanner itself reported that exact path for that exact repo. |
| Subprocess | `spawn('gh', [...])`, never a shell string, so a repo name or search term cannot become a command. API paths are validated (`/`-prefixed, no whitespace). 30 s timeout, 20 MB output cap, and a pinned env allowlist — `GH_TOKEN`/`GITHUB_TOKEN` are forwarded to the child untouched, never read into a variable. |

The client secret Atlassian requires for confidential clients is read from env at
boot, never written to disk by this app and never sent to the browser.

## Setup

1. **GitHub** — nothing to register. Just be logged in:
   ```bash
   gh auth login --scopes "repo,read:org"
   gh auth status                       # should show the account you want
   ```
   Already logged in but short on scopes? `gh auth refresh --scopes "repo,read:org"`.
   The UI shows the active account and warns when a scope is missing. Multiple
   accounts: the app acts as gh's **active** one; change it with `gh auth switch`.
2. **Atlassian app** — <https://developer.atlassian.com/console/myapps/> → OAuth 2.0 (3LO).
   Permissions: Jira API → `read:jira-work`, `write:jira-work`, `read:jira-user`.
   Callback URL: `http://127.0.0.1:4178/api/auth/jira/callback`.
3. One command does the rest — preflight, dependencies, build, serve:
   ```bash
   ./run.sh               # or: npm start   → http://127.0.0.1:4178
   ```
   It checks node and `gh`, creates `.env` from the template on first run, warns
   about a missing `repo` scope or an empty `JIRA_CLIENT_ID`, installs dependencies
   only when `package-lock.json` is newer than `node_modules`, builds the UI, and
   serves API and UI on the same port.

   | Command | What it does |
   |---|---|
   | `./run.sh` | build + serve everything on `$PORT` (default 4178) |
   | `./run.sh dev` | hot reload — API on `$PORT`, Vite UI on 5173 |
   | `./run.sh check` | preflight only, changes nothing |
   | `PORT=4179 ./run.sh` | run on another port |

   Then fill `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` in the generated `.env`
   and restart. GitHub needs nothing in `.env` at all.

## Flow

1. GitHub is already connected if `gh` is logged in. Connect Jira (consent popup).
2. Pick the Atlassian site — the header selector appears when your account can
   reach more than one.
3. Filter cards: Open / Assigned to me / **Unassigned** / **Someone else's** / All.
   Picking a card that is not yours is a supported path.
4. The detail pane shows subtasks, the description, and a permission strip read
   from Jira `mypermissions` (`transition`, `edit`, `assign`, `comment`). Actions
   you lack permission for are disabled with the missing permission in the tooltip
   rather than failing at click time.
5. Change status via the real transition list for that workflow; **Assign to me**
   claims an unassigned card when `ASSIGN_ISSUES` allows it.
6. Choose the repo. The picker opens on **Local clones** — every directory under
   `REPO_SCAN_ROOTS` (default `~/git`) whose `origin` points at GitHub, showing its
   path and current branch. Switch to **All on GitHub** to search the org instead.
   Then pick the base branch. Push permission is checked before the button
   enables, and again server-side. Branch name is generated from the card and stays
   editable. The result gives you a checkout line — pointed at the actual clone
   (`git -C /home/you/git/thing fetch origin … && git -C … switch …`) when the repo
   came from the local list.

Branch template: `BRANCH_TEMPLATE` env, default `{type}/{key}-{slug}` →
`feature/PROJ-123-add-oauth-device-login`. Placeholders: `{type}` (mapped from the
Jira issue type: bug→bugfix, story/task→feature, epic, spike, hotfix), `{key}`,
`{slug}`. Names are run through git ref-format sanitising before use.

## Layout

```
run.sh              single entrypoint: preflight, deps, build, serve
server/
  index.js          fastify boot, session cookie, CSRF + security headers
  config.js         env, loopback origin, scopes
  secrets.js        in-memory credential vault (the security core)
  db.js             better-sqlite3 cache schema + statements
  auth/jira.js      PKCE authorize, code exchange, refresh, jiraFetch
  routes/           auth.js · jira.js · github.js
  lib/              gh.js (gh CLI adapter) · localRepos.js (clone scanner)
                    http.js (fetch + redaction) · branchName.js
web/src/            React UI, Primer tokens in styles.css
```

## Known limits

- `gh auth login` needs a TTY, so the UI will not run it for you — it shows the
  command and a Re-check button. Deliberate: driving an interactive login from a
  web page is exactly the pattern this app is built to avoid.
- GitHub identity is machine-level, not per-session. Whoever can reach the
  loopback port acts as your active `gh` account.

- Jira Cloud only (`/rest/api/3` + `api.atlassian.com`). Jira DC/Server needs
  different endpoints and auth.
- Refresh tokens are not persisted, so a server restart means re-consenting.
  That is the trade you chose; switch to an OS keyring if it gets annoying.
- Issue search caps at 50 results per query — there is no pagination UI yet.
- Requires `gh` >= 2.x on `PATH`.
- The clone scanner only recognises `origin`. A repo whose GitHub remote is named
  something else (`upstream`, `fork`) will not appear in the local list.
