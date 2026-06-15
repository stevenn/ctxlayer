# N — OKF bundles + path-based link consistency

Builds on [M — OKF interop](M-okf.md) (per-file frontmatter import/export). This
deep-dive covers the **bundle** layer: up/down a whole directory tree, the
reserved `index.md` / `log.md` files, and a **path-based, always-consistent**
inter-doc link system. Spec:
<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

## Scope (locked)

- **Bundle = a folder subtree.** Export at any chosen level of the virtual
  folder hierarchy (incl. root). The selected folder is the bundle root; its
  descendants are the bundle.
- **Import = a subfolder.** An uploaded bundle's directory tree is grafted
  under a chosen target folder, preserving its internal structure.
- **Both `tar.gz` and `zip`**, import and export.
- **Links are path-based and always consistent.** See "Link model" — this
  replaces the opaque `/app/docs/{id}` scheme and makes document moves rewrite
  referencing docs.

## Bundle model

A bundle is not a new entity — it's a **(root folder, doc set)** pair computed
on demand:

- The bundle root is a `FolderPath` (e.g. `/specs/api`, or `/` for everything).
- The doc set is every non-deleted doc whose `folder` is the root or a
  descendant (`folder = root OR folder LIKE root || '/%'`).
- A doc's **concept path** within the bundle is its path relative to the root:
  `relpath(doc) = <doc bundle path> minus <root>`, `.md` appended.

### Concept path of a doc

The OKF concept ID is the file path minus `.md`. ctxlayer derives a doc's
**bundle path** as:

- **git-synced docs** → `git_path` (already repo-relative, immutable, unique
  per source). This is the canonical case.
- **authored docs** → `${folder}/${slug}.md` (folder `/specs/api`, slug
  `auth-guide` → `specs/api/auth-guide.md`; root folder → `auth-guide.md`).

`slug` is immutable, so an authored doc's bundle path only changes when its
**folder** changes (a move) — which is exactly the event the link system
must react to.

## Link model (OKF-native, graph-tracked, move-aware)

Links are **OKF-native**: the BlockNote href *is* the OKF concept path. No
`/app/docs/{id}` scheme, no boundary translation — the link is stored, rendered,
exported, and imported as the same path string.

### Feasibility (BlockNote 0.51) — verified

The editor already stores protocol-less absolute-path hrefs verbatim (today's
`/app/docs/{id}` doc links, inserted via `editor.createLink` /
`insertInlineContent`, round-trip and are click-intercepted in
`blocknote-editor.tsx:213`). A `/specs/api/auth.md` href is the identical shape,
so no link-extension reconfig / protocol allowlist is needed.
`renderBlocksToMarkdown` emits `[text](href)` verbatim → a native OKF link. (One
thing to test in Stage 2: BlockNote's *markdown→blocks* parser preserving a
`/x.md` href on import — the graph doesn't depend on it, only the editor's
display does.)

### Storage

- A doc-to-doc link is stored in the body as a **path** href — global-absolute
  in the ctxlayer folder hierarchy, which doubles as the OKF concept path:
  `${doc.folder}/${doc.slug}.md` (e.g. `/specs/api/auth-guide.md`; root →
  `/auth-guide.md`). Relative `./auth.md` is also accepted on import.
- `DocLinkPicker` inserts this path href (was `/app/docs/{id}`).
- A new **`doc_links`** table is the resolved graph: one row per (source doc,
  raw ref), with the resolved `target_doc_id` (NULL = dangling). Rebuilt from
  the doc's markdown on every save (regex on `](…)` — server-side, no BlockNote
  needed, robust to any editor parse quirk).
- **Legacy** `/app/docs/{id}` hrefs keep resolving (back-compat) and normalize
  to the path form on the next save — a one-time forward conversion, not a
  standing translation layer.

### Resolution (on save)

`reindexDocLinks(docId)`:
1. scan the doc body for markdown links,
2. for each in-app link (a path, or a legacy `/app/docs/{id}`), resolve to a
   target doc id via the path↔doc map (or the id directly for legacy),
3. upsert `doc_links` rows; unresolved → `target_doc_id = NULL` (dangling,
   tolerated per spec but surfaced in the UI as "N broken links").

Legacy `/app/docs/{id}` hrefs keep resolving (back-compat) and are **normalized
to the path form on the next save** — no bulk R2 migration.

### Move / rename consistency (the "affects moves" part)

Links resolve by **slug** (location-independent), so a folder move never *breaks*
a link — only the stored path *string* can go stale. The single place a path
must be current is the OKF **export**, so rather than mutating bodies on move
(authored bodies are Yjs-owned by the collab DO — the live state is the Y.Doc in
`yjs/snapshot.bin`, not just `snapshot.json`, so a server-side href rewrite would
need Yjs surgery + race open editors), we **recompute each link's path at export
/ render time** from the target's current location:

- `rewriteDocLinkHrefs(env, markdown)` scans the doc's links, resolves each
  doc-link (slug, or legacy id) → the target doc → its **current**
  `conceptPath(folder, slug)`, and replaces the href. Dangling + external links
  are left as-is.
- Applied in `composeOkfExport` (per-doc export) and the bundle export, so any
  doc that links to a moved doc exports the correct current path — no body
  mutation, no Yjs work, moves stay cheap.

(The `doc_links` graph's `target_doc_id` is already slug-resolved, so a move
needs no graph update either. Refreshing the *stored* body href string so the
editor displays the new path is an optional, separable Yjs effort — deferred.)

### Editor link UX (one tool, docs + external URLs)

Today the editor has TWO link affordances: BlockNote's built-in "Create Link"
button (arbitrary URLs) and a custom "Doc" button (`DocLinkToolbarButton` +
a "Link to doc" slash item). That duplication goes away:

- **Hide** BlockNote's built-in create-link button (filter it out of
  `getFormattingToolbarItems()`); keep its native **LinkToolbar** (edit / open /
  remove an existing link — works for any href).
- **One** "Link" tool (formatting-toolbar button + slash item) opens a unified
  picker: search → pick a doc (inserts the **OKF path href**) OR type/paste a
  **URL** (inserts that href). Both via `editor.createLink(href)` /
  `insertInlineContent`.
- **External URLs are first-class**: the same tool creates them; `doc_links`
  ignores any non-doc href (http/mailto/anchor); `renderBlocksToMarkdown` emits
  them verbatim; the click interceptor only catches doc-path hrefs and lets the
  browser handle real URLs.

(Extending BlockNote's *internal* URL input with inline doc-autocomplete would
be more native but means overriding its LinkToolbar component — deferred; the
unified replacement button delivers the same single-experience result.)

### Navigation + rendering

- In-app, the click interceptor (`blocknote-editor.tsx`) resolves a doc-path
  href → the target doc id **client-side** (a host-provided `resolveDocHref`
  backed by the doc list) and routes to `/app/docs/{id}`. Resolution is by
  **slug** (the path's last segment minus `.md`; slugs are globally unique).
  Route params stay **ids** — the editor passes `:id` straight to the collab
  WebSocket + content fetch, so slug-routing is intentionally avoided.
  Slug-resolution means a link never truly breaks on a folder move — the
  move-rewrite below only keeps the *path* (and thus OKF export) accurate.
- `renderBlocksToMarkdown` emits the path href as-is (already an OKF concept
  link). On **bundle export** the global-absolute path is re-rooted relative to
  the bundle root (pure path math, not a scheme change); on **import** archive
  paths are resolved to the newly-created docs (two-pass).

## Reserved files

- **`index.md`** — generated on export per directory (root carries
  `okf_version: "0.1"` frontmatter; body is the spec's `* [Title](url) - desc`
  section list). On import, recognized + parsed for the okf_version, then
  **not** materialized as a doc (it's a generated artifact).
- **`log.md`** — generated on export from `doc_revisions` (root = bundle-wide,
  `## YYYY-MM-DD` newest-first, `* **Update**: …`). On import, recognized +
  skipped (not a concept doc). Optional both ways per spec.

## Archives

- **`fflate`** (new dep, pure-JS, workerd-safe) for zip + gzip.
- A small hand-rolled **tar** reader/writer (512-byte headers — deterministic,
  ~120 LoC) for the tar container; `tar.gz` = tar → `fflate.gzip`.
- Worker-side only (`apps/worker/src/bundle/*`). Format chosen by the request
  (`?format=tar.gz|zip`).

## Flows

### Export (`GET /api/bundles/export?root=<folder>&format=<fmt>`)

1. enumerate the doc set under `root`,
2. per doc → OKF markdown (`composeOkfExport`) keyed at its concept path,
   with in-app links rewritten to bundle-relative paths,
3. generate `index.md` (per dir) + `log.md` (root),
4. pack → archive, stream as a download.

Large trees are packed in a streamed pass; a soft doc-count ceiling logs what
was dropped rather than silently truncating.

### Import (`POST /api/bundles/import` → queue)

Upload + unpack must not run inside one request's CPU budget for big bundles,
so import is **queue-backed** (like git-sync / reindex):
1. the route stores the uploaded archive to R2 + enqueues an import job
   (target folder, format),
2. the consumer unpacks, validates each concept file (parseable frontmatter +
   non-empty `type`; everything else soft per §9), creates docs under
   `targetFolder/<archive path>`,
3. **second pass**: build the archive-path → new-doc-id map, rewrite each body's
   in-bundle links to in-app path hrefs, resolve `doc_links`.

## Schema

`0027_doc_links.sql` — the link graph:

```sql
CREATE TABLE doc_links (
  source_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,  -- NULL = dangling
  target_ref    TEXT NOT NULL,            -- raw href as authored (path or legacy)
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (source_doc_id, target_ref)
);
CREATE INDEX idx_doc_links_target ON doc_links(target_doc_id);  -- incoming refs + move rewrite
```

No new column for concept path — it's derived (`git_path` or `folder`+`slug`).

## Surfaces

- **REST**: `GET /api/bundles/export`, `POST /api/bundles/import`,
  `GET /api/bundles/import/:jobId` (status). `GET /api/docs/:id/links`
  (incoming/outgoing for the editor's consistency panel).
- **UI**: an "Export bundle" action on a folder node (format picker); an
  "Import bundle" action (archive upload + target-folder picker + progress); a
  rail indicator for broken links on a doc.

## Staged build

1. Foundation — this doc, `fflate`, `0027_doc_links`.
2. Link model — path href + resolver + `doc_links` population + dangling surface.
3. Move consistency — rewrite referencing bodies on move/rename.
4. Archive core — tar/tar.gz/zip + `index.md`/`log.md` generate+parse.
5. Bundle export.
6. Bundle import (queue-backed, two-pass).
7. UI + tests.

## Risks

- **workerd CPU/time** for big bundles → import is queue-backed; export streams.
- **Two-pass import ordering** — links resolve only after all docs exist;
  dangling is legal so a missing target is fine.
- **Legacy id links** — supported + normalized on save, no bulk migration.
- **Path collisions on import** — two archive files mapping to the same target
  path: de-dupe by suffixing the slug (same collision handling as create).
- **Move amplification** — moving a high-fan-in doc rewrites many bodies +
  cuts many revisions; batch the writes and cap/notify on very large fan-in.
