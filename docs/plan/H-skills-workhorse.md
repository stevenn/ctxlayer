# H — Skills & the context workhorse (M7+ direction)

> Strategic plan written 2026-05-26 for the next phase after M6 closed.
> Status: approved direction, not yet implementation. Refine before
> opening M7.

## Context

ctxlayer is currently a **two-surface** context layer: (a) curated docs
with RAG, (b) gated MCP upstream proxy with centralised creds. M1–M6 are
closed and the app is production-ready for manual onboarding.

The next phase widens the scope: **make ctxlayer the org-aware operating
manual for every tool the agent touches**. When a dev opens Claude Code
(CLI) or Claude.ai (web), the agent should arrive pre-equipped with:

1. **Tool inventory** — already done (`list_upstreams` + namespaced
   proxied tools).
2. **Per-tool know-how** — new: "what does Datadog mean in *this* org,
   which dashboards matter, what's the naming convention for Linear teams."
3. **Procedural skills** — new: short, declarative playbooks the agent
   loads on demand.
4. **Cross-tool workflows** — new: skills that compose multiple
   upstreams (alert → ticket → CRM note in one declared procedure).

Constraints that drive design choices below:

- Deliver to **both** CLI agents and web agents from a single source of
  truth. CLI agents get filesystem-anchored skills; web agents get them
  over MCP.
- Stay **MCP-spec aligned**. Skills surface as MCP **resources** (and a
  small set of helper tools), not as a custom protocol. This keeps every
  current and future MCP client compatible without bespoke work.
- Keep the connector roadmap **generic**. The deliverable is the
  primitive that works for *any* MCP upstream; specific connector kits
  (Linear, Datadog, HubSpot, ServiceHub, Mixpanel, Pendo, Freshdesk) are
  content authored on top, not engineering milestones.

## Strategic framing

### Skills as a first-class primitive

Skills get their **own top-level model**, parallel to `documents`. They
share infrastructure (R2 snapshot pattern, revisions, BlockNote editor
component, tag/visibility model, audit log) but present as a distinct
first-class object end-to-end: own DB tables, own queries, own REST
namespace, own admin page, own MCP surface.

Why separate (not `documents.kind = 'skill'`): skills diverge from docs
in non-trivial ways — they have frontmatter that's semantically
required, they have *attachments* (skill ↔ upstream tool joins) that
docs don't, their lifecycle (draft → published) matters more than for
docs, and they're consumed eagerly rather than searched. Modelling them
as a doc kind would have meant carrying skill-only fields as nullables
on every doc row and special-casing every doc query — the wrong
trade-off.

**Schema sketch** (new migration `0008_skills.sql`):

```sql
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,                     -- "when to invoke", short
  trigger_text    TEXT NOT NULL DEFAULT '',          -- freeform "when X" hints
  status          TEXT NOT NULL DEFAULT 'draft'      -- draft | published | archived
                  CHECK (status IN ('draft','published','archived')),
  current_rev_id  TEXT,
  r2_snapshot     TEXT,                              -- body markdown in R2
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE skill_revisions (    -- mirrors doc_revisions exactly
  id, skill_id, author_id, r2_key, byte_size, content_hash, created_at
);

CREATE TABLE skill_tags (         -- mirrors doc_tags
  skill_id, tag_kind, tag_value   -- tag_kind ∈ team | product | topic
);

CREATE TABLE skill_attachments (
  skill_id     TEXT NOT NULL REFERENCES skills(id),
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id),
  tool_name    TEXT NOT NULL DEFAULT '',  -- '' = whole upstream
  PRIMARY KEY (skill_id, upstream_id, tool_name)
);
```

Skills are **open-read by default** (same stance as docs per the org-IA
rationale in `F-org-ia.md`); tags filter `list_skills` default scope but
don't gate read.

Frontmatter is stored as first-class columns (`description`,
`trigger_text`, `status`) rather than parsed from the body. The body
is pure markdown — what the agent reads. The editor surfaces the
metadata fields above the body. This keeps validation strict without
making editing fiddly.

### Skills surface on MCP via spec-aligned primitives

Three integration points, all standard MCP:

1. **Resource template** `mcp://ctxlayer/skills/{slug}` —
   `list()` returns every skill the user can see (status=published);
   reading a URI returns the markdown body. This is the primary
   delivery mechanism for web agents.

2. **Tool `list_skills(scope?)`** — returns `{ slug, name, description,
   attached_to: [{ upstream_slug, tool_name|null }] }`. Lightweight
   discovery without paying the body-fetch cost.

3. **Extension to `list_upstreams` and `list_my_context`** — each
   upstream row gains an `attached_skills` array, each upstream-tool
   sub-row also gets one. The agent sees "this Linear upstream has a
   `linear-triage` skill" without a separate roundtrip.

We deliberately **do not** mirror skills as MCP `prompts`. MCP prompts
fit "fill-in arguments and produce messages" — too rigid for procedural
playbooks. Resources are the right primitive for "reference content I
load when needed". Revisit if a real prompt use case appears.

### CLI binary as M7 day-one

A new package `packages/cli/` ships a `ctxlayer` binary (bun build to
single executable). Commands:

- `ctxlayer login` — OAuth via the existing provider, using a new
  first-party OAuth client registered with `loopback_redirect` for
  PKCE on `http://127.0.0.1:<random>/cb`. Stores tokens in a
  per-OS config file (`~/.config/ctxlayer/credentials.json` with
  `0600` on mac/linux, `%APPDATA%\ctxlayer\credentials.json` relying
  on user-profile ACLs on Windows). This matches what `gh`, `gcloud`,
  `aws`, `wrangler`, and `vercel` all do — keychain integration is
  not on the roadmap. The credential is a revocable OAuth bearer/
  refresh token scoped to one user, not a long-lived API key; the
  threat model doesn't warrant three native code paths for marginal
  hardening. No new auth subsystem in the worker — reuses
  `oauth/provider-config.ts` + DCR.
- `ctxlayer pull` — fetches all visible published skills via a new
  `GET /api/skills/export` endpoint, materialises them under the
  Claude skills dir resolved via `os.homedir()` —
  `~/.claude/skills/ctxlayer/<slug>/SKILL.md` on mac/linux,
  `%USERPROFILE%\.claude\skills\ctxlayer\<slug>\SKILL.md` on
  Windows — with Claude Code's expected frontmatter:

  ```
  ---
  name: <slug>
  description: <skills.description>
  ---
  <markdown body>
  ```

  Adds a managed-by header comment to discourage local edits. Writes
  use LF line endings explicitly — Claude Code expects LF and Git on
  Windows otherwise smears CRLF into the file on next checkout.

- `ctxlayer watch` — long-poll (or SSE) for changes; re-runs `pull`
  on diff. Optional v1 — `pull` on demand is enough for most flows.

Cross-platform helpers: a small `openUrl()` wrapper branches on
`process.platform` (`open` / `xdg-open` / `start ""`) for the OAuth
browser hand-off. Filesystem paths always via `path.join` +
`os.homedir()`, never hardcoded `~` or forward slashes.

**Distribution: npm package, not a binary.** Ship as
`@ctxlayer/cli`; primary install path is `npx @ctxlayer/cli <cmd>`
(zero install, always latest) with `npm i -g @ctxlayer/cli` or
`bun add -g @ctxlayer/cli` for users who want a pinned global. The
audience here is devs already running Claude Code — they have a
Node/Bun runtime by definition, so the "single binary, no runtime
needed" pitch doesn't apply. Going npm-first sheds the
cross-compile matrix, Windows SmartScreen / macOS Gatekeeper
signing concerns, and the per-target path-handling test surface in
exchange for one `npm publish` step. Same precedent as `wrangler`,
`vercel`, `claude` itself.

Single-binary distribution (`bun build --compile`) stays as a
deferred nice-to-have if a real user complains about the Node/Bun
dependency. Not on the M7c critical path.

Why ship the CLI in M7 rather than later: filesystem-loaded skills get
zero MCP-latency lookup *and* match how Claude Code natively expects to
find them. Waiting risks an MCP-only stopgap calcifying.

### Catalogue diff + skill staleness

We already cache `tools/list` per upstream with a 24h TTL in
`upstream_tools`. Extend the refresh job (`upstream/http-client.ts`
populates the cache; `mcp/tools-proxy.ts` reads it):

1. **Diff** new vs. cached `inputSchema` per tool; persist diff
   summary alongside the row.
2. If changed *and* any `skill_attachments.tool_name` row points at
   that `(upstream, tool)` pair → mark each attached skill `stale=true`
   (computed at read time; no schema column needed).
3. Admin SPA surfaces stale flags on the skills list and the upstream
   detail page: "Linear added `parent_id` to `create_issue` — review
   the `linear-triage` skill." Drift is visible, never silent.

Drafting on first-seen tools is **not** part of this pipeline — a raw
schema-to-prose autogen produces padding the agent could derive from
`inputSchema` anyway. The interesting drafting story is operator-
triggered with richer inputs; see next.

### AI-assisted skill drafting

The unfair advantage here is **what feeds the prompt**, not the model.
Most CLIs that generate "MCP skills" only see the tool schema.
ctxlayer sees four richer inputs the agent itself doesn't:

| Source | Where it lives | What it tells the model |
|---|---|---|
| `tools/list` per upstream | `upstream_tools` cache | What the tool claims |
| Doc corpus + RAG | Vectorize | What the org *says* about the tool |
| `usage_events` | M6 pipeline | What the org *actually does* with it |
| Existing skills | `skills` table | House style, tone, structure |

The drafting modes form a ladder; M8 ships the middle of it:

| Tier | Inputs | Model | Output |
|---|---|---|---|
| 1. Schema reformat | tool schema | template, no LLM | A doc, not a skill. Skip — expose the schema directly. |
| 2. Schema → skill | tool schema | small LLM | Reads like the docs the agent already has. Low marginal value; **don't ship**. |
| 3. Usage-mined | tool schema + `usage_events` slice | **Claude Code CLI (operator-local)** | "When customers report bugs, file Linear with `team_id=ENG`, `labels=triage`." Codifies tacit knowledge the agent can't derive. |
| 4. RAG-grounded | tool schema + top-k docs about the upstream | **Claude Code CLI (operator-local)** | Skill that respects existing org wiki conventions. Keeps drafts coherent with published practice. |
| 5. Interactive co-author | admin freeform prompt + tools + docs + usage | **Claude Code CLI (operator-local)** | Operator runs `ctxlayer draft-skill linear --prompt "triage flow"`; the CLI fetches the bundle, shells `claude -p`. The day-to-day author flow. |
| 6. Proactive suggestions | usage-sequence mining → cluster → draft | embed (Workers AI, server) + draft (Claude Code CLI, local) | Worker spots recurring tool sequences (`datadog.search → linear.create → slack.post` in N sessions) and surfaces a suggestion; operator runs `ctxlayer draft-skill --from-suggestion <id>` to draft. Defer to M10. |

**M8 ships Tiers 4 + 5.** Tier 3 is implicit — Tier 5's prompt
includes usage-event aggregates whenever the (user, upstream, tool)
slice has any. Tier 6 waits until the corpus has enough months of
usage data to mine meaningfully.

**Model split.** Drafting runs locally on the operator's machine via
their already-installed Claude Code CLI; embeddings stay server-side.

- **Drafting: Claude Code CLI (operator-local).** The new
  `ctxlayer draft-skill` command fetches a curated context bundle from
  the worker (`GET /api/skills/draft-context`), then shells out to the
  operator's `claude -p` in non-interactive mode with `--json-schema`
  enforcing a `{frontmatter, body}` envelope. This piggybacks on the
  operator's existing Claude subscription — zero worker-side LLM spend,
  no `ANTHROPIC_API_KEY` secret to manage, and the drafting model is
  whatever the operator's Claude Code runs (Opus 4.7 today, not capped
  at Sonnet via API). Operators without Claude Code installed fall
  back to the SPA's manual-author flow; the CLI bails gracefully with
  a pointer to install. See M8 for the command shape.
- **Embeddings / clustering: Workers AI.** `@cf/baai/bge-base-en-v1.5`
  is already wired for doc RAG; reuse it for the usage-event
  clustering that feeds Tier 6. No LLM-on-Workers-AI path in the
  drafting hot loop (or anywhere else — Workers AI stays scoped to
  embeddings).

The server-side helper is `api/skills-draft-context.ts` — it assembles
the JSON bundle (tool schemas, top-k RAG-relevant doc excerpts, usage
aggregates, existing-skill style refs) and returns it. No LLM
involvement on the worker. The drafter system prompt + JSON output
schema live in `packages/cli/` alongside the `draft-skill` command,
since that's where the Claude shell-out happens; iterating on prompt
quality is a CLI release, not a worker deploy.

**Quality / trust controls.**

- Every draft persists `drafted_from`: `'cli+claude-code'` /
  `'cli+claude-code+agentic'` (deferred Design B) / `'manual'`. Plus
  a `drafter_meta` field capturing the Claude Code version + model
  the operator's CLI reported at draft time, so reviewers know which
  model produced a given draft.
- Schema-reference linter runs server-side at draft-save time: parse
  the draft body for tool / argument references and flag any that
  don't exist in current `tools/list`. Server-side so the same check
  protects manually-authored drafts, not just CLI ones.
- Accept/edit/reject signal: track which drafts get published
  unchanged vs heavily edited vs deleted. Feeds prompt iteration on
  the drafter system prompt in `packages/cli/`.
- **Never auto-publish.** Operator review gate stays absolute.

### Tool-attached docs (a smaller, parallel concern)

Docs can also benefit from attachment to upstreams — "the Datadog
naming convention" is a reference doc, not a procedural skill. We add
`doc_attachments` with the same shape as `skill_attachments`. This is
1 extra migration + 1 extra query + reuse of the attach UI. Cheap.

Together: an upstream's `attached_skills` is procedural ("here's how
to triage"), `attached_docs` is referential ("here's what the field
names mean"). The agent loads whichever it needs.

### What we don't build

- **No skill execution engine.** Skills are markdown the agent reads;
  the agent decides what to do. We're not building LangGraph.
- **No skill marketplace across orgs.** Each install owns its skills.
  Sharing is a v3 concern.
- **No forking upstream docs.** Skills/docs here are *org-specific
  overlays*, not replacement docs. The Linear MCP describes Linear's
  API; ctxlayer describes *your* Linear conventions.
- **No prompts primitive** (yet). Re-evaluate when a real use case
  surfaces.

## The connector approach (content, not engineering)

The deliverable across M9+ is **content authored on the generic
primitive**, not engineering per service. We don't pre-commit to a
"first" connector — the operator picks one (or several) based on
which MCP upstreams they actually run.

Two service patterns inform what to author per kit:

- **Reference-heavy services** (Datadog, Mixpanel, Pendo) — the value
  is *naming/taxonomy* docs. Agent needs to know what your
  event/dashboard/monitor names mean. Mostly `doc_attachments`.
- **Workflow-heavy services** (Linear, Freshdesk, HubSpot,
  ServiceHub) — the value is *procedural* skills. Triage, escalation,
  status transitions. Mostly `skill_attachments`.

A typical kit = 1 reference doc + 1–2 skills per service, all
attached. Cross-tool skills (e.g. "incident-response" attached to
both Datadog and Linear) become useful once 2+ services are kitted.

The roadmap below frames this as "soak testing", not service-specific
milestones — the engineering is done after M7; M9+ is authoring +
validation cycles.

## Proposed milestones

**M7 — Skills primitive (worker + admin SPA + CLI binary).**

Sub-deliverables, all in one milestone:

- **M7a (worker)**: `0008_skills.sql` migration, queries
  (`db/queries/skills.ts`, `db/queries/skill-attachments.ts`,
  `db/queries/doc-attachments.ts`), REST namespace
  (`api/skills.ts`, `api/skill-attachments.ts`,
  `api/doc-attachments.ts`, `api/skills-export.ts` for CLI),
  MCP registrations in `mcp/session-do.ts` mirroring the
  existing docs pattern (lines 85–305), `list_upstreams` /
  `list_my_context` payloads extended with `attached_skills`
  + `attached_docs`.
- **M7b (SPA)**: new `routes/admin/skills.tsx` (CRUD + attach UI
  modelled on `routes/admin/users.tsx`), per-skill editor page
  (`routes/skills/[id]/edit.tsx`) reusing the BlockNote editor
  shell from docs, attach-skill/doc widget on the upstream detail
  page.
- **M7c (CLI)**: `packages/cli/` with `login`, `pull`, optional
  `watch`. New first-party OAuth client registered via
  `oauth/provider-config.ts`. Published as `@ctxlayer/cli` on npm
  (single `npm publish` per release; no cross-compile matrix, no
  per-OS binary signing). File-based credential storage on all OSes
  — keychain integration is not on the roadmap. CI smoke job on
  `windows-latest` runs `npx @ctxlayer/cli --version` +
  `npx @ctxlayer/cli pull --dry-run` against a deployed preview so
  path-handling regressions surface in CI rather than on a user's
  machine.

Verification: register the existing GitHub upstream, author one skill
attached to a specific tool, verify on Claude.ai (skill appears in
`list_skills`, fetchable as resource, surfaces in
`list_upstreams.attached_skills`) and on Claude Code (same plus
filesystem load after `ctxlayer pull`).

**M8 — Catalogue diff + AI-assisted drafting.**

- Extend `upstream/http-client.ts` refresh path to diff
  `inputSchema` per tool; persist a diff summary alongside the cache
  row.
- Admin SPA surfaces stale badges on skills and upstream pages.
- New worker endpoint `api/skills-draft-context.ts` assembles a JSON
  context bundle on `GET /api/skills/draft-context?upstream=&tool=&prompt=`
  — tool schemas, top-k RAG-relevant doc excerpts, usage aggregates
  for the relevant (user, upstream, tool) slice, and 2-3 existing-
  skill style refs. No LLM involvement on the worker.
- New CLI command `ctxlayer draft-skill <upstream> [--tool <tool>]
  [--prompt "..."]` in `packages/cli/`:
  1. Fetch the context bundle from `/api/skills/draft-context`.
  2. Locate `claude` on PATH; bail with a friendly install pointer
     ("install Claude Code from claude.com/claude-code, or author
     manually in the admin SPA") if missing.
  3. Shell out: `claude -p --bare --no-session-persistence
     --output-format json --json-schema=<envelope>
     --system-prompt=<drafter> --tools ""`, piping the bundle +
     freeform prompt on stdin. `--bare` avoids leakage from whatever
     directory the operator is in.
  4. Parse the `{frontmatter, body}` response, render a preview, and
     on operator confirmation `POST /api/skills` with
     `status='draft'`, `drafted_from='cli+claude-code'`, and the
     `drafter_meta` from Claude Code's JSON envelope.

  Ships **Tier 4** (RAG-grounded, the `--tool <tool>` form) and
  **Tier 5** (freeform `--prompt`); Tier 3 usage aggregates fold into
  the context bundle automatically when present.
- Schema-reference linter runs server-side at `POST /api/skills`:
  flag tool/argument references in the body that don't appear in
  current `tools/list`. Same check applies to manually-authored
  drafts, not just CLI ones.
- Admin SPA "draft" affordance becomes a copy-command helper: builds
  the right `ctxlayer draft-skill ...` invocation for the operator's
  clipboard from whatever upstream/tool context they're viewing. No
  browser-driven LLM call.
- **Out of scope:** Tier 6 proactive suggestions (deferred to M10 —
  the suggestion engine runs on the worker but the *draft* still
  runs through `ctxlayer draft-skill --from-suggestion <id>`
  locally); auto-stub on first-seen tools (intentionally dropped;
  see "Catalogue diff + skill staleness"); Anthropic API drafting on
  the worker (replaced by operator-local Claude Code CLI); agentic
  drafting via `--mcp-config` (deferred Design B power-user variant).

**M9+ — Connector kits (content milestones).**

For each MCP upstream the operator runs:

1. Register the upstream (already supported).
2. Trigger catalogue refresh + (optionally) AI-draft skills/docs.
3. Curate → publish 1 reference doc + 1–2 skills per service.
4. End-to-end validation: demonstrate one agentic flow that *would
   have failed without the kit* (e.g. "what's broken in payment?"
   finds the right Datadog dashboard via the naming overlay rather
   than guessing).

Candidate services in scope per the briefing: Linear, Datadog,
HubSpot, ServiceHub, Mixpanel, Pendo, Freshdesk. Order is operator's
call.

**Cross-tool composite skills** become valuable from M10 onward —
once 2+ kits are live, author an "incident-response" or
"customer-debug" skill that attaches to multiple upstreams.

**M11 (optional, deferred) — Search over skills.**

If `list_skills` discovery becomes noisy at >50 skills, index skills
into Vectorize for semantic discovery (`search_skills`). Defer until
the volume problem is real. Skills are eagerly-loaded by design;
embedding-based discovery is a backstop, not the main path.

## Critical files & touchpoints (M7)

- `apps/worker/src/db/migrations/0008_skills.sql` — new.
- `apps/worker/src/db/queries/skills.ts`,
  `skill-attachments.ts`, `doc-attachments.ts` — new.
- `apps/worker/src/api/skills.ts`,
  `skill-attachments.ts`, `doc-attachments.ts`,
  `skills-export.ts` — new (follow `admin-upstreams.ts` pattern,
  apply `requireAdmin` + `requireCsrf` per route).
- `apps/worker/src/api/admin-upstreams.ts` — extend GET to embed
  attached skills/docs.
- `apps/worker/src/mcp/session-do.ts` — register
  `mcp://ctxlayer/skills/{slug}` template + `list_skills` /
  `get_skill` tools (lines 85–305 are the model).
- `apps/worker/src/upstream/oauth-provider.ts` /
  `oauth/provider-config.ts` — register the new first-party CLI
  OAuth client (loopback redirect, PKCE).
- `apps/web/src/routes/admin/skills.tsx`,
  `apps/web/src/routes/skills/[id]/edit.tsx` — new.
- `apps/web/src/lib/api.ts` — add `fetchSkills`, `createSkill`,
  `attachSkill`, etc.
- `packages/shared/` — Zod schemas for skill DTOs +
  attachment DTOs.
- `packages/cli/` — new workspace, published as `@ctxlayer/cli` on
  npm (no single-binary build in M7c; deferred). M7c ships `login`,
  `pull`, optional `watch`. The `draft-skill` command lands in M8
  (separate npm release) and is where the drafter system prompt +
  JSON output schema live.
- Per-workspace `typecheck`/`lint`/`test` stubs (per CLAUDE.md
  convention).

## Verification (M7)

- D1 migration applies clean on local + remote
  (`/migrate` + `/migrate --remote`).
- A skill can be authored, attached to a registered upstream tool,
  appears in:
  - `list_skills` MCP tool response,
  - `mcp://ctxlayer/skills/{slug}` resource read,
  - `list_upstreams` `attached_skills` array,
  - the admin SPA skills list + upstream detail page.
- `npx @ctxlayer/cli login` against the live deploy succeeds
  (loopback PKCE) on mac/linux and on Windows (`windows-latest` CI
  job — the loopback dance is the most likely Windows-specific break).
- `npx @ctxlayer/cli pull` writes the skill file with valid Claude
  Code frontmatter at the per-OS path (`~/.claude/skills/...` on
  mac/linux, `%USERPROFILE%\.claude\skills\...` on Windows) using
  LF line endings.
- A Claude Code session in a fresh directory picks up the pulled
  skill and uses it when triggered.
- A Claude.ai session attached to the deployed worker reads the
  skill via MCP resource and uses it.
- `/smoke` passes; security-pass invariants hold (no token logging
  in new code paths, upstream URL validation extends to skill-export
  endpoint if it ever proxies anything).

## Open questions for follow-up planning

These don't block M7 but should be decided before M8/M9:

- **Skill versioning at the CLI**: does `ctxlayer pull` always
  overwrite, or honour a local pin? (Default: overwrite, with a
  managed-by header. Pin support if real friction surfaces.)
- **Org-shared CLI auth**: does the CLI's OAuth client need device
  flow for headless contexts (CI, ssh sessions)? Add later only if
  asked.
- **Single-binary build**: revisit if a user complains about the
  Node/Bun runtime requirement. `bun build --compile` cross-compiles
  all six targets from one runner, so it's cheap to add later — but
  pulls in Windows SmartScreen + macOS notarization concerns that
  npm distribution sidesteps entirely.
- **Agentic drafting (Design B) via `--mcp-config`**: deferred
  power-user variant of `ctxlayer draft-skill`. Instead of the worker
  bundling context, the CLI loads ctxlayer's MCP server into Claude
  via `--mcp-config` and lets Claude fetch the context it needs
  itself. More agent-native but unbounded tool turns and harder to
  debug. Revisit only if the server-bundled bundle (Design C, the M8
  primary) ever feels too rigid for a real authoring case.
- **Composite skill modelling**: do cross-tool skills need explicit
  workflow metadata (ordered upstream list?) or is one skill with
  multiple `skill_attachments` rows enough? Start simple; revisit
  after M10.
