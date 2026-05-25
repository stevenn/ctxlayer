# M3 — Realtime collab (Yjs): slice plan

Status: **drafting**, slices not yet started.

PLAN.md sketches the M3 surface; this doc breaks it down for execution
and locks in two deviations from the original plan that fell out of a
30-minute spike on dependencies.

## Deviations from PLAN.md

### D-M3.1 — `@blocknote/server-util` is not viable in workerd

PLAN.md said the reindex consumer would "switch its input from
BlockNote JSON to Y.Doc via `@blocknote/server-util`". That package
hard-depends on **jsdom** (a full Node DOM shim) inside its
`ServerBlockNoteEditor`. `jsdom` does not run on Cloudflare Workers —
even with `nodejs_compat`, workerd lacks `vm`, `fs`, etc. that jsdom
expects.

We do not need to rewrite the rendering pipeline for M3. Instead:
- The **DocRoomDO** is a realtime relay + Y.Doc persister. It writes
  binary Y.Doc snapshots to R2 so a cold session bootstraps with the
  latest collaborative state.
- The **SPA** continues to drive the existing `PUT /api/docs/:id/content`
  autosave — but now triggered off Y.Doc updates rather than the
  ProseMirror onChange. Existing route already writes a JSON revision
  row, refreshes the R2 snapshot, and enqueues reindex. No server-side
  Y.Doc→markdown conversion needed.
- A "single writer" Yjs-awareness election decides which connected tab
  performs the REST autosave so concurrent tabs don't multiply
  revisions for the same converged state.

Net: identical user-visible behaviour to the original plan
(two-tab live edit, search reflects edits within seconds) without
porting `@blocknote/server-util` to a Worker-compatible runtime.

### D-M3.2 — `DocRoomDO` stays non-SQLite

PLAN.md (M2 closure) collapsed DO migrations to a single tag with
`DocRoomDO` in `new_classes` (not `new_sqlite_classes`). Storage backend
is sticky once chosen (G3). WebSocket Hibernation does not require SQLite
— it uses the same `ctx.storage` regardless of backend — so M3 keeps
the existing class and uses `ctx.storage.put('snapshotMeta', …)` for the
tiny scheduler bookkeeping it needs. R2 holds the Y.Doc bytes.

## Slices

### M3a — `DocRoomDO` foundation + `/collab/:docId` WS upgrade

**Deliverable**: two SPA tabs connect to `wss://…/collab/:docId`,
edits in tab A appear in tab B without round-tripping through the REST
autosave. DO survives eviction by reloading the Y.Doc binary snapshot
from R2.

Server work:
- Add deps to `apps/worker`: `yjs@^13`, `y-protocols@^1`.
- `apps/worker/src/collab/doc-room-do.ts`:
  - Acceptor uses `ctx.acceptWebSocket(server)` so hibernation can
    serialise pending sockets across evictions.
  - `webSocketMessage(ws, msg)` decodes the message via
    `y-protocols/sync` + `y-protocols/awareness`, applies updates to
    the in-memory `Y.Doc`, then re-broadcasts to peers via
    `ctx.getWebSockets()`.
  - First message on cold-wake: lazy-load `docs/{id}/yjs/snapshot.bin`
    from R2 and `Y.applyUpdate(doc, bytes)` before responding.
  - **Snapshot on every applied update**, coalesced through a single
    in-flight write (latest pending bytes win). Alarms-based debouncing
    is wrong under WS Hibernation: the DO can be evicted mid-edit and
    the alarm fires on a fresh instance with stale R2 state. Instead
    we accept the per-update R2 write cost (≤$0.01/active-hour at our
    sizes) and lag R2 behind the live Y.Doc by at most one write.
  - **Resync on wake**: after lazy-loading from R2, send `syncStep1`
    to every still-attached socket so peers re-deliver any updates
    they applied between the last persisted snapshot and the eviction.
    Closes the otherwise-lossy window introduced by the previous bullet.
  - On flush: `Y.encodeStateAsUpdate(doc) → R2.put(yjs/snapshot.bin)`.
    Revision row + reindex stay on the SPA-driven REST path (see M3c).
- `apps/worker/src/index.ts`:
  - New `/collab/:docId` Hono handler (already routed through
    `run_worker_first`). Pre-upgrade: session cookie via `requireUser`,
    `canEditDoc` for write, otherwise upgrade as read-only (server
    discards `sync_step2` from read-only peers).
  - `fetch` returns 426 on non-WebSocket requests so HTTP-only probes
    fail loudly.
  - Forwards the upgrade to `env.DOC_ROOM_DO.get(idFromName(docId)).fetch(req)`.

Auth pre-upgrade matters because WebSocket handshakes carry the
session cookie automatically (same-origin) but cannot send a CSRF
header. Treat the upgrade like `GET /content` — cookie-only is OK
because the DO never accepts state-changing HTTP without re-checking
on each WS message.

### M3b — Reindex pipeline stays put

No server changes — explicitly. Existing
`reindex-consumer.ts` keeps reading BlockNote JSON revisions written by
the SPA autosave path. We delete the "M3 switches consumer input"
sentence from PLAN.md once this slice ships.

### M3c — SPA: Yjs provider + onChange autosave

**Deliverable**: BlockNote in `docs-editor.tsx` runs with Yjs collab
on; the Save button + dirty banner disappear; debounced autosave fires
off Y.Doc `update` events instead of the editor's onChange.

Web work:
- Add deps to `apps/web`: `yjs@^13`, `y-protocols@^1`.
- New `apps/web/src/lib/yjs-ws-provider.ts`: thin WebSocket provider
  implementing the Yjs `sync` + `awareness` protocols against
  `/collab/:docId`. Roll our own (≤150 LoC) rather than depending on
  `y-websocket` because that package assumes a `room` query param and
  reconnect logic with its own opinions; we want same-origin cookie
  auth and a single room per socket.
- Update `BlockNoteEditor` to accept an optional
  `{ doc: Y.Doc, provider, awareness, user }` collab config and forward
  it to `useCreateBlockNote({ collaboration: {…} })`.
- Update `docs-editor.tsx`:
  - Construct a `Y.Doc` + `WSProvider` per `docId`.
  - Replace `dirty` / Save / unsaved-changes Modal with a connection
    status badge ("Live" / "Reconnecting…" / "Read-only").
  - Yjs `update` listener: 5s debounce → if this tab won the awareness
    leader election, render the current blocks to BlockNote JSON via
    `editor.document` and call existing `putDocContent(id, …)`.
  - Awareness leader election: the connected client with the lowest
    `clientID` writes. Deterministic, no coordination needed.

Title / delete / sharing flows stay on REST as today.

### M3d — Verification

Per PLAN.md "M3" verify bullet plus a few we've already learned to
check:

1. Open `/app/docs/:id` in two browser tabs. Type in A → appears in B
   within ~100ms. Awareness cursors visible.
2. `wrangler tail` while editing; `wrangler tail kill` the DO; both
   tabs reconnect; tab A's previously typed text persists (because the
   DO reloads `snapshot.bin` on re-wake).
3. `wrangler d1 execute DB --command "SELECT count(*) FROM doc_revisions WHERE doc_id='…'"`
   grows by exactly 1 per ~5s edit window (single-writer election).
4. `bun run logs:all` shows a reindex enqueue per revision; remote
   `search_docs` reflects the new content within ~30s.
5. Cold-start: close all tabs for 10 min, reopen → editor renders the
   last persisted state (snapshot.bin path verified).
6. Read-only viewer: revoke editor's `canEdit`, refresh; tab connects
   but their local edits don't propagate (server discards their
   `sync_step2`).

## R2 layout addition

```
docs/{docId}/snapshot.json                   # existing
docs/{docId}/revisions/{revId}.json          # existing
docs/{docId}/yjs/snapshot.bin                # NEW (M3a) — Y.encodeStateAsUpdate
```

No `revisions/{ts}.bin` rotation — the JSON revision list is the
human-facing history; the Y.Doc binary is purely the live-collab
substrate and only ever has one current snapshot.

## Out of scope for M3

- Multi-user cursor names/colors UI polish (basic awareness only).
- Conflict UI for the rare "two writers raced the autosave" case;
  awareness-leader election makes this unreachable in practice.
- Yjs `gc` tuning — defaults are fine at our doc sizes.
- Migrating `DocRoomDO` to SQLite-backed. (Stays in `new_classes`, see
  D-M3.2.)

## Dependency on later milestones

None. M3 lands independently. M4 (upstream proxy) does not touch the
collab path.
