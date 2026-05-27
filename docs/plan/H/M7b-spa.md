# M7b — SPA design (admin skills + attach UI)

> Implementation spec for the React SPA changes in [[H]] M7. Builds on
> the worker REST + DTOs from [[M7a-worker]]. Cites
> [[00-implementation-state]] for patterns.
> Status: design, not yet implemented.

## Scope

- New admin list page `/app/admin/skills` (mirrors
  `apps/web/src/routes/admin/users.tsx`).
- New per-skill editor `/app/admin/skills/[id]/edit` (reuses
  BlockNote shell from `docs-editor.tsx`, simpler — no collab, no
  folders, no locks).
- Attach widget on existing admin upstream detail page:
  `apps/web/src/routes/admin/upstreams.tsx` gets a new section
  "Attached skills + docs" per upstream + per tool.
- Doc-attach widget on doc editor: tiny "Attached to upstreams"
  panel in the right-rail of `routes/docs-editor.tsx`.
- `apps/web/src/lib/api.ts` additions for skills + attachments.
- Copy-command helper component used by both admin/skills and the
  upstream tool detail rows (used in M8 — plumbed in M7b).

Out of scope (deferred): non-admin "browse skills" page,
search-skills UI, public skill registry.

## Routes

| Path | File | Auth | Purpose |
|---|---|---|---|
| `/app/admin/skills` | `routes/admin/skills.tsx` | admin | List + filters + new-skill button + status toggle per row |
| `/app/admin/skills/[id]/edit` | `routes/admin/skill-editor.tsx` | admin | Per-skill editor; metadata rail + BlockNote body |

Existing `routes/admin/upstreams.tsx` and `routes/docs-editor.tsx`
gain new sections; no new routes.

Route registration in `apps/web/src/router.tsx` (or wherever routes are
declared — check on impl). Both wrapped in `<RequireAdmin>`.

## Admin list page — `routes/admin/skills.tsx`

**Structure** (follows `admin/users.tsx` 1:1):

```
<AdminLayout>
  <Toolbar>
    <SkillStatusFilter />            ← All | Draft | Published | Archived
    <SkillTagFilter />               ← team / product / topic chips
    <SearchInput />                  ← substring on title + description
    <Button onClick={openCreate}>+ New skill</Button>
  </Toolbar>

  <table class="data-table">         ← reuses existing table styles
    columns: Title | Slug | Status | Tags | Attached | Updated
    rowClick → setEditingId(skill.id)
  </table>

  {editingId && (
    <SkillDrawer
      skillId={editingId}
      onClose={() => setEditingId(null)}
      onChanged={reload}
    />
  )}

  {creating && (
    <CreateSkillModal onClose={…} onCreated={(id) => navigate(`/app/admin/skills/${id}/edit`)} />
  )}
</AdminLayout>
```

**Data flow:**

- `useEffect` with `AbortController` → `fetchSkills({ status: filter })`
- `reload()` on demand (after drawer close, attach changes, create)
- `withBusy()` helper around mutations (same shape as `admin/users.tsx:160-171`)
- All mutations via `api.ts` helpers; CSRF handled by `request()` automatically

**Drawer (`SkillDrawer`)** for quick metadata edits + status toggle +
attach UI summary:

- Sections (matching `<Section>` / `<KV>` helpers used in
  `admin/users.tsx:288-340`):
  1. **Identity** — slug (read-only), title, description (multiline),
     trigger_text (multiline, optional). Inline-save on blur with
     `patchSkill`.
  2. **Status** — radio: Draft / Published / Archived. Status change
     fires `patchSkill({status})` with confirm-via-`dialogs.confirm`
     when transitioning out of Published (operator might want to
     un-publish a live skill — warn).
  3. **Tags** — `<TagPane>` reuse from docs (`apps/web/src/components/tags/tag-pane.tsx`
     or equivalent). Calls a new `replaceSkillTags` API helper.
  4. **Attachments summary** — read-only list of upstream slugs +
     tool names. "Manage" button → opens `AttachManagerDialog` (see
     below).
  5. **Revisions** — collapsed accordion; on expand, fetches
     `/api/skills/:id/revisions`. Latest 10. Read-only view, no
     restore in v1 (defer).
  6. **Open editor** — primary button → navigates to
     `/app/admin/skills/[id]/edit` (markdown body).
  7. **Danger zone** — `dialogs.confirm` then `softDeleteSkill`.

**Components reused from existing codebase:**

- `<Drawer>` shell (whatever `admin/users.tsx` uses).
- `<Section>` / `<KV>` layout helpers — extract into
  `apps/web/src/components/admin/section.tsx` if not already shared
  (the helpers live inline in `admin/users.tsx:288-340`; M7b is a
  good moment to lift them).
- `dialogs.confirm` / `dialogs.alert` from `lib/dialogs.tsx` — never
  native `confirm()`.
- `<TagPane>` from doc editor.

## Per-skill editor — `routes/admin/skill-editor.tsx`

Simpler than `docs-editor.tsx` (825 lines). Skills are admin-only and
single-writer; no Yjs / WS / lock / folder logic.

**Structure:**

```
<EditorLayout>
  <Breadcrumb>Admin / Skills / {title}</Breadcrumb>

  <ActionRow>
    <SaveStatus>{dirty ? 'unsaved' : 'saved 5s ago'}</SaveStatus>
    <Button onClick={openInDrawer}>Edit metadata</Button>   ← reuses SkillDrawer
    <Button variant="primary" onClick={publish}>Publish</Button>
  </ActionRow>

  <Title>{title}</Title>                        ← double-click to rename, calls patchSkill
  <Description>{description}</Description>      ← single-line gray subtitle

  <Grid columns="1fr 280px">
    <BlockNoteEditor
      ref={editorRef}
      initialBlocks={initialBlocks}
      editable={true}
      onChange={markDirty}
    />

    <Rail>                                       ← sticky right rail
      <KV label="Slug">{slug}</KV>
      <KV label="Status">{status}</KV>
      <KV label="Created">{createdAt} by {createdBy.name}</KV>
      <KV label="Last edit">{updatedAt}</KV>
      <Section label="Attachments">
        {attachments.map(a => <AttachmentChip ... />)}
        <Button onClick={openAttachManager}>Manage</Button>
      </Section>
      <Section label="Tags">
        <TagPane ... />
      </Section>
    </Rail>
  </Grid>
</EditorLayout>
```

**Save flow** (much simpler than docs):

- Track `dirty` via `BlockNoteEditor`'s `onChange`.
- Debounce: `SAVE_IDLE_MS=2000` (faster than docs' 5s; single-writer,
  no contention to worry about).
- On save: `editorRef.current.getBlocks()` → `putSkillContent(id, {blocks})`.
- Save status badge: "saving…" / "saved 12s ago" / "save failed
  (retry)".
- No leader election (single writer). No max-timeout flush. No
  collab provider.

**No collab in v1**: skills are admin-only and rarely edited
concurrently. If two admins do edit simultaneously, last-write wins —
acceptable for v1. If real friction surfaces, plumb Yjs via the
existing `CollabWSProvider` (DocRoomDO would need a sibling
`SkillRoomDO`). Defer.

**Initial blocks fetch:**

- On mount: `Promise.all([fetchSkill(id), fetchSkillContent(id)])`.
- `fetchSkillContent` returns `DocContent` from `GET /api/skills/:id/content`.

## Attach manager dialog

Used both from the skill drawer ("Manage attachments") and from the
upstream detail page ("Attach skill to this upstream/tool").

**Component:** `apps/web/src/components/attach/attach-manager.tsx`

**Two entry modes:**

1. **Skill-anchored** (from `SkillDrawer.AttachmentSummary`):
   - Shows current attachments for skill `S`.
   - Add row: dropdown of upstreams → if upstream selected, dropdown
     of cached tools (loaded from `/api/upstreams/:id/tools`) + "whole
     upstream" option (`toolName=''`). Save → `attachSkill`.
   - Remove: × on each chip → `dialogs.confirm` → `detachSkill`.
2. **Upstream-anchored** (from `admin/upstreams.tsx` per-upstream
   section, or per-tool section):
   - Shows current attachments for upstream `U` (optionally tool `T`).
   - Add row: dropdown of skills (typeahead by title/slug) → save →
     `attachSkill`.
   - Remove: × → confirm → `detachSkill`.

Both flows use the same component with a `mode` prop.

**Doc attachments** reuse the same component but call
`attachDoc`/`detachDoc`. Render in the doc editor's right rail.

## Upstream detail page extensions —
`routes/admin/upstreams.tsx`

The page already expands rows to show cached tools (added in
`8c3deea`). Add:

- **Per-upstream attachments section** in the expanded row, above the
  tools table:
  ```
  Attached skills: [chip1, chip2, …]  [+ Attach skill]
  Attached docs:   [chip1, chip2, …]  [+ Attach doc]
  ```
- **Per-tool attachments** as a sub-row in the cached-tools table:
  each tool row gets `attached_skills` + `attached_docs` chips +
  "+ Attach" affordances.

Data already in `UpstreamToolsResponse` after M7a's extension; SPA
only needs render + dialogs wiring.

## Doc editor extensions —
`routes/docs-editor.tsx`

Add to the right-rail (lines ~460-491 are the existing rail area):

```
<Section label="Attached to upstreams">
  {attachedTo.map(a => <UpstreamChip slug={a.upstreamSlug} tool={a.toolName} />)}
  <Button onClick={openAttachManager}>Attach</Button>
</Section>
```

Doc attachments fetched as part of `fetchDoc(id)` response (M7a's
`DocDetail` gains an optional `attachments` array — confirm during
M7a impl that this round-trips cleanly).

## `apps/web/src/lib/api.ts` additions

Following the `fetchDocs` / `createDoc` / `patchDoc` /
`putDocContent` pattern:

```ts
// skills
export const fetchSkills = (params?: { status?: SkillStatus; tag?: string; q?: string }, signal?: AbortSignal) =>
  request('/api/skills' + qs(params), z.array(SkillSummary), { signal });

export const fetchSkill = (slug: string, signal?: AbortSignal) =>
  request(`/api/skills/${slug}`, SkillDetail, { signal });

export const fetchSkillContent = (id: string, signal?: AbortSignal) =>
  request(`/api/skills/${id}/content`, DocContent, { signal });

export const createSkill = (input: CreateSkillInput) =>
  request('/api/skills', SkillDetail, { method: 'POST', body: JSON.stringify(input) });

export const patchSkill = (id: string, patch: PatchSkillInput) =>
  request(`/api/skills/${id}`, SkillDetail, { method: 'PATCH', body: JSON.stringify(patch) });

export const putSkillContent = (id: string, content: DocContent) =>
  request(`/api/skills/${id}/content`, z.object({ revisionId: z.string(), byteSize: z.number() }),
          { method: 'PUT', body: JSON.stringify(content) });

export const deleteSkill = (id: string) =>
  request(`/api/skills/${id}`, z.undefined(), { method: 'DELETE' });

// skill attachments
export const fetchSkillAttachments = (skillId: string, signal?: AbortSignal) =>
  request(`/api/skill-attachments?skillId=${skillId}`, z.array(SkillAttachmentRef), { signal });

export const attachSkill = (input: { skillId: string; upstreamId: string; toolName?: string }) =>
  request('/api/skill-attachments', z.undefined(), { method: 'POST', body: JSON.stringify(input) });

export const detachSkill = (input: { skillId: string; upstreamId: string; toolName?: string }) =>
  request('/api/skill-attachments', z.undefined(), { method: 'DELETE', body: JSON.stringify(input) });

// doc attachments (mirror of above)
export const fetchDocAttachments = …;
export const attachDoc = …;
export const detachDoc = …;

// tags
export const replaceSkillTags = (skillId: string, tags: TagBag) => …;
```

`qs()` helper for query strings — if not already in `api.ts`, add.

## Copy-command helper (used by M8, plumbed in M7b)

Small component for the SPA "draft via CLI" affordance:

```tsx
<CopyCommandButton
  command={`ctxlayer draft-skill ${upstream.slug}${tool ? ` --tool ${tool.toolName}` : ''}`}
  label="Draft this skill via CLI"
/>
```

Lives at `apps/web/src/components/cli/copy-command-button.tsx`. Used
in M7b only on the upstream tool detail rows as a placeholder ("draft
this — requires Claude Code"); becomes useful in M8.

## File inventory

### New files

```
apps/web/src/routes/admin/skills.tsx
apps/web/src/routes/admin/skill-editor.tsx
apps/web/src/components/admin/section.tsx              (lifted from inline helpers in admin/users.tsx)
apps/web/src/components/attach/attach-manager.tsx
apps/web/src/components/attach/upstream-chip.tsx
apps/web/src/components/cli/copy-command-button.tsx
apps/web/src/components/skill-drawer.tsx               (used by admin/skills.tsx)
```

### Modified files

```
apps/web/src/router.tsx                       — register 2 new admin routes
apps/web/src/lib/api.ts                       — add ~12 helpers (skills + attachments + tags)
apps/web/src/routes/admin/upstreams.tsx       — per-upstream + per-tool attachment sections
apps/web/src/routes/admin/users.tsx           — non-functional: extract Section/KV to shared (one diff line)
apps/web/src/routes/docs-editor.tsx           — right-rail "Attached to" section
```

## Components NOT to build

- **Skill folder organisation**: docs have it (M5 feature); skills
  don't need it in v1 — flat list with tag filters is enough at
  expected volumes (<100 skills). Defer.
- **Skill lock UI**: docs have locks (M5); skills are admin-only so
  there's no realistic contention worth a lock UI. Defer.
- **Skill sharing UI**: skills are open-read; no per-skill ACL exists
  on the worker side either.
- **Public skills browse page (non-admin)**: skills are consumed by
  agents via MCP. Non-admin SPA users have no reason to browse them.
  If a real use case appears, add a `/app/skills` read-only page
  later.

## Verification

1. **Admin list page**: visits `/app/admin/skills`, sees empty state →
   create skill via modal → row appears → click row → drawer opens with
   metadata → close, click again → editor opens at `/app/admin/skills/[id]/edit`.
2. **Editor save loop**: edit body, badge shows "unsaved" → 2s later
   shows "saved Xs ago" → reload page, body persists → check
   `GET /api/skills/:id/revisions` shows the revision.
3. **Status flow**: draft → publish via radio in drawer → list shows
   "Published" badge → confirm via `GET /api/skills` non-admin user
   sees it → `list_skills` MCP tool returns it.
4. **Tags**: add `team:eng` tag in drawer → `GET /api/skills?tag=team:eng`
   returns it; `?tag=team:other` excludes it.
5. **Attach flow**:
   - From SkillDrawer, attach to upstream Linear (tool: `create_issue`).
   - Visit `/app/admin/upstreams`, expand Linear row, see the skill
     listed under the `create_issue` tool sub-row.
   - Detach via × → confirm dialog → skill chip disappears.
6. **Doc attachments** (parallel to skills): create a doc, attach to
   upstream, verify in upstream page and in doc editor's right rail.
7. **CSRF + admin gating**: hit `POST /api/skills` from the SPA without
   the CSRF token (delete cookie, retry) → 403; hit as non-admin user →
   403; admin endpoints not in the admin nav for non-admins.
8. **Dialogs**: every confirm/prompt/alert uses `dialogs.*`, not
   native `window.confirm`. Grep `routes/admin/skills.tsx` +
   `skill-editor.tsx` for `window.confirm` → must be zero.
9. **Type contract**: `bun run typecheck` clean across all workspaces;
   shared DTO additions visible in both `web` and `worker` via the
   `@ctxlayer/shared` alias.

## Sequencing within M7b

1. **`api.ts` + skill drawer + admin list page** — minimal CRUD with
   no editor (use "open editor" button as a TODO). Reaches "create
   + see in table" in one commit.
2. **Skill editor** — add the `/edit` route + page; reaches "edit
   body, save, persists" in one commit.
3. **Attach manager + integration into upstreams page** — adds the
   per-upstream and per-tool sections. Reaches "attach + see in MCP
   list_upstreams" end-to-end.
4. **Doc attachments** — same component, parallel wiring on doc
   editor. Independent commit; only depends on M7a's doc-attachments
   API.

Each step independently deployable; SPA build never broken in between.

## Risks called out

- **Lifting `Section`/`KV` helpers** out of `admin/users.tsx`
  inadvertently changes that page's render — keep the lift mechanical
  (re-export from the new file, delete the inline copies, no API
  change).
- **`SkillEditor` reusing `BlockNoteEditor`** — confirm the wrapper's
  `editable` + `onChange` props work without the `collaboration`
  prop. Per [[00-implementation-state]] the BlockNote wrapper
  branches on `collaboration` presence — single-writer path exists
  and is tested in some context (e.g. read-only preview). Sanity-check
  during impl.
- **Attach manager dropdowns** — listing all upstreams + all tools
  can be many entries. For v1 ship a plain `<select>`; if it becomes
  unwieldy add a typeahead component later. No early abstraction.
- **Right-rail in docs-editor.tsx** is already crowded (lines
  462-491). Adding a new section is fine but watch sticky-positioning
  behaviour. Test scroll on a long doc body.
