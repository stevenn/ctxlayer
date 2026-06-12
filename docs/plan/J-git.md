# J — Git integration (mirror + write-back)

Topic deep-dive for the git subsystem: how ctxlayer mirrors `*.md` out of a
repo into the doc store and turns editor edits into PRs/MRs. Reference, not a
roadmap — trust the code (`apps/worker/src/git/**`, migrations `0015`/`0016`).

## What it is

A **git source** mirrors markdown files from a repo branch into documents
(inbound, cron-driven) and opens a PR/MR for edits made in the ctxlayer editor
(outbound, on demand). It is **not** an MCP upstream — separate tables
(`git_sources`, `git_pull_requests`, `documents.git_*` columns) — but reuses
the same three credential strategies (`shared_bearer` / `user_bearer` /
`user_oauth`) and the AES-GCM seal/open helper.

We **never clone**. Every operation is a REST call over `fetch` (Workers has
no git binary / no Node sockets). Reads list the markdown tree + fetch single
files; writes create a head branch, commit one file, and open a PR/MR.

## Architecture

- **Provider abstraction** — `git/provider.ts` defines `GitProviderClient`
  (6 methods: `resolveRef`, `listMarkdownTree`, `readFile`, `blobWebUrl`,
  `openOrUpdatePullRequest`, `getPullRequestState`) and `createGitProvider`
  dispatches on `git_sources.provider`. One impl per provider, all raw-fetch.
- **Inbound sync** — `git/sync.ts` (cron via `git-sync-consumer.ts`): walk the
  tree, import changed `*.md` as `documents` (body stored as R2
  `docs/{id}/source.md`), auto-tag with the source's product, enqueue reindex.
  A doc with `git_sync_state` in {`local_edits`,`pr_open`} is **not** clobbered
  when the remote moves — it's flagged `conflict` for the operator. (An editor
  save sets `local_edits`; see `markGitDocLocallyEdited` — without it a cron
  sync would silently overwrite unproposed edits.)
- **Outbound write-back** — `git/writeback.ts`: diff the edited markdown vs the
  synced baseline (`source.md`); if changed, commit onto a **deterministic**
  per-doc head branch (`ctxlayer/doc-<slug>-<docId8>` — stable so a crash-retry
  can't spawn a duplicate PR) and open/refresh the PR. PR state is **polled**
  (`getPullRequestState`), no webhooks.
- **Credentials** — `git/credentials.ts`: reads use `read_strategy` (shared org
  PAT, or the acting user's token during interactive sync); writes prefer the
  user's token (correct authorship) per `write_strategy`, falling back to the
  shared token (bot author). All sealed with AES-GCM; provider response bodies
  are **never** logged.
- **URL trust** — `git/url.ts`: https-only at the dial site (defense-in-depth
  over the runtime's `global_fetch_strictly_public`); per-provider API + web
  base resolution.

## Provider REST mapping

All three converge on the same operations behind the interface. Differences
the impls absorb:

| Op | GitHub | GitLab (v4) | Azure DevOps (7.1) |
|----|--------|-------------|--------------------|
| project key | `owner` + `repo` | `repo` = project path/id (URL-encoded) | `owner`=org, `project`, `repo` |
| resolve base sha | `GET /git/ref/heads/{b}` | `GET /repository/branches/{b}` → `commit.id` | `GET /refs?filter=heads/{b}` → `objectId` |
| list md tree | `GET /git/trees/{ref}?recursive=1` | `GET /repository/tree?recursive&per_page` (paged) | `GET /items?recursionLevel=Full` |
| read file | `GET /contents/{p}?ref=` (base64) | `GET /repository/files/{p}?ref=` (base64) | `GET /items?path=&includeContent=true` (raw) |
| commit file | create branch + `PUT /contents` | `POST /repository/commits` (branch+commit in one) | `POST /pushes` (oldObjectId + changeType) |
| open PR/MR | `POST /pulls` | `POST /merge_requests` | `POST /pullrequests` |
| PR id | `number` | `iid` | `pullRequestId` |
| auth header | `Authorization: Bearer` | `Authorization: Bearer` (PAT or OAuth) | `Authorization: Bearer` (Entra) |

Sources for the exact request shapes live in the PR that adds each provider.

## Friendly auth (planned)

Today the user-facing path is **paste-a-PAT** (`PUT /api/git-sources/:id/
credentials`). DCR (self-registration) is unavailable across all three
providers, so the friendlier replacement maps onto the existing **`user_oauth`
STATIC** sub-mode (admin pre-registers one client per provider; the static
machinery in `upstream/oauth-static.ts` is reused):

- **GitHub** → GitHub App user token (Contents R/W + Pull requests R/W).
- **GitLab** → auth-code + PKCE, scope `api` (`write_repository` is git-over-
  HTTPS only and won't reach the REST endpoints). Rotating refresh.
- **Azure DevOps** → Microsoft Entra (ADO's own OAuth is deprecated), scope
  `499b84ac-…/.default` + `offline_access`, `vso.code_write` pre-granted —
  exactly the static-Entra pattern already shipped for the ADO MCP upstream.

## Browser-redirect "open PR" (planned)

Optional UX: push the branch+commit via API, then 302 the user to the
provider's New-PR page to review + click the final button in their own UI.
Prefill support: GitHub (`compare/…?quick_pull=1&title=&body=`) ✓, GitLab
(`merge_requests/new?merge_request[source_branch]=…`) ✓, Azure DevOps
(`pullrequestcreate?sourceRef=&targetRef=` — branches only, **no** title/body,
so ADO prefers full REST). Note: the redirect does **not** reduce the required
write scope — the branch+commit still go through the API.

## Sub-PR sequencing

PR #4 ("git multi-provider + friendly auth") is delivered as slices:

- **4a — GitLab provider** ✅ `gitlab.ts` + shared `provider-util.ts` + url
  helpers + `createGitProvider` + tests. Paged tree walk, `%2F`-encoded reads,
  one-call commit (`start_branch`), MR open/refresh.
- **4b — Azure DevOps provider** ✅ `azure.ts`. Branch-create ref + `pushes`
  (parent `oldObjectId` + `changeType`), version descriptors, PR open. Auth
  auto-detects Entra JWT (`Bearer`) vs classic PAT (`Basic`).
- **4c — Friendly `user_oauth` git auth** — GitLab PKCE + ADO Entra, reusing
  the static-OAuth flow; replaces paste-PAT. *(next)*
- **4d — Browser-redirect open-PR** — GitHub/GitLab deep-link, ADO via REST.

All three providers are **unit-tested but write-back is not yet exercised
against a live GitLab/ADO repo** end-to-end (needs a repo + token) — same
caveat GitHub carried before its first real run. The read/sync path is lower
risk.
