# O — First-result skill hint (design note, not yet built)

Status: **designed 2026-08-27, awaiting go.** The last discovery channel from
the 2026-08 skill-discovery work; everything else in that thread shipped
(guidance-first instructions ≤2048, per-tool description suffix, skills as MCP
prompts, org-side client instruction line).

## Why this channel

Field evidence (Desktop/Cowork session, 2026-08-27): MCP server `instructions`
**bind late** on some clients — turn 1 had neither tools nor instructions, the
block landed mid-session — and nothing distinguishes "no instructions" from
"not yet connected". Tool descriptions are deferred on Claude Code for large
gateways. A hint fused to the FIRST tool result per upstream is the only
channel that is *timing-immune*: by definition it arrives after the connection
settled, in the same context window as the work, exactly when the agent is
committed to using that upstream. For workflow playbooks this is nearly as good
as up-front: the first Driver call is almost always `get_codebase_names`, and
the playbook governs everything after it.

## Mechanism

On the **first successful result per upstream per MCP session**, append ONE
additional `{ type: 'text' }` content item to the result:

    ⟦ctxlayer⟧Org playbooks exist for up-driver: sk-driver-ai-planning-skill
    ("Driver AI Planning skill v2"), sk-driver-ai-research-skill ("Driver AI
    Research skill v2") — fetch via get_skill if relevant to the task.⟦/ctxlayer⟧

- **Additive content item, never payload mutation.** No `_ctxlayer_skills` key
  inside the upstream's own JSON — gateway data dressed in upstream shape is
  exactly the source confusion the provenance model exists to prevent. A
  separate marker-wrapped text item is the same pattern as the truncation
  notice and the GitHub nudges.
- **Slugs + titles only, never descriptions.** Slugs are validated kebab-case;
  titles are short author text already exposed org-wide via `list_skills`.
  Descriptions are non-admin-author free text — pushing them unrequested into
  every member's context would make skill *authoring* an org-internal
  injection channel. The agent pulls the body via `get_skill` (structured,
  chosen). Cap the hint at ~300 chars (first N refs + `+N more`).
- **Whole-upstream attachments only** (`tool_name = ''`). Per-tool attachments
  already ride the tool description suffix; repeating them here is noise.
- **Once per upstream per session.** Per-DO in-memory `Set<upstreamId>` on
  `UpstreamProxyRegistry` (the registry instance is session-scoped). Survives
  `refresh()`/`reload_upstreams` naturally; resets on reconnect, which is
  correct (new session = new context window).
- **Placement: in the registry's tool handler, after `runUpstreamCall`
  returns, on the single surface-return path** — NOT inside the runner. The
  runner's sanitise step strips ⟦ctxlayer⟧ from upstream text (that is the
  unforgeability claim); appending after it keeps the marker intact without
  a sanitiser carve-out. The nudge processors run *before* sanitise because
  they REPLACE untrusted text; this hint only APPENDS first-party text, so
  after is both simpler and safer.
- **Async path:** attach to the submit acknowledgment surface (the token
  response), not the eventual `poll_task` replay — the ack is the first thing
  the agent reads for that upstream, and `poll_task` replays are byte-stable
  cached results that must not grow a new segment on re-read.
- **Skip on error results** — error surfaces already carry nudges/scrubbing,
  and "read the playbook" attached to a failure reads as blame. First
  *successful* result only; an upstream that only ever errors never hints.

## Stance amendment this requires

Current invariant: success results pass through sanitise + cap only, never
augmented (sole exception: the truncation notice, which REPLACES an over-cap
result). This feature is a deliberate, bounded amendment: **first-party,
admin-gated (attachment is an admin mutation), marker-wrapped, size-capped,
once per upstream per session, additive only.** When implemented, update the
invariant text in `result-postprocess.ts`'s header and the CLAUDE.md security
notes to name this exception, the way §1a names the error-scrub exception.

## Interactions

- **Response-size cap:** append AFTER the cap check; the hint is bounded and
  must not be able to evict upstream payload (and a capped result already
  carries the truncation notice — skip the hint there, one first-party
  segment per result is enough).
- **Usage accounting:** hint bytes are gateway overhead — exclude from
  `respJson` so per-upstream usage stays honest.
- **`structuredContent`:** untouched. Clients that read only structured
  output miss the hint; acceptable — those flows are programmatic, not
  planning contexts.

## Tests (when built)

Runner/registry level: hint present on first success (marker-wrapped, slugs +
titles, no descriptions); absent on second call; absent when no whole-upstream
attachments; absent on isError and on truncated results; async ack carries it,
`poll_task` replay does not; `respJson` excludes hint bytes; sanitiser does
not strip the appended marker (append is post-sanitise).
