# M — Open Knowledge Format (OKF) interop

ctxlayer is an **early adopter of the [Open Knowledge Format
(OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**
— Google Cloud's open, human- and agent-friendly convention for representing
*knowledge*: the metadata, context, and curated insight that surrounds data and
systems. OKF is a directory of UTF-8 Markdown files, each carrying YAML
frontmatter, distributed as a git repo / tarball / subdirectory.

ctxlayer's doc library is, structurally, an OKF bundle: curated Markdown with
metadata, edited collaboratively and served to agents over MCP. This deep-dive
documents how ctxlayer reads, edits, and writes OKF so that an OKF bundle
round-trips through the platform.

- **Spec**: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>
- **Format home**: <https://github.com/GoogleCloudPlatform/knowledge-catalog>

## The model: the doc rail *is* the frontmatter editor

There is no separate "OKF panel". The doc editor's right rail edits the OKF
frontmatter directly; import populates those fields, export serialises them.

| OKF frontmatter | ctxlayer | Where |
|---|---|---|
| `type` *(required)* | `documents.doc_type` (free string) | rail "Type" row, OKF-badged |
| `description` | `documents.description` | rail "Description" row, OKF-badged |
| `resource` *(URI)* | `documents.resource` | rail "Resource" row, OKF-badged |
| `tags` | free-form `doc_tags` (`tag_kind='tag'`) | rail "Tags" section, OKF-badged |
| `title` | `documents.title` | doc header |
| `timestamp` | `documents.updated_at` | "Last edited" |
| concept ID *(file path − `.md`)* | `slug` + `folder` / `git_path` | rail "Slug" / "Folder" |
| `okf_version`, any unknown keys | `documents.okf_frontmatter` (raw block) | preserved verbatim, invisible |

Teams and products are **not** OKF — they gate visibility (search scope), while
OKF `tags` only organise. Only the free-form tags map to OKF `tags`. See
[F-org-ia](F-org-ia.md).

## Round-trip contract

OKF requires consumers to **preserve unknown keys**. ctxlayer honours this by
storing the raw frontmatter block (`okf_frontmatter`) verbatim on import and
re-emitting it on export — the well-known fields above are overlaid from the
rail (so UI edits win), and every other producer key rides through untouched.

The serialiser lives in `packages/shared/src/frontmatter.ts`
(`splitFrontmatter` / `parseFrontmatter` / `emitFrontmatter`), built on the
[`yaml`](https://eemeli.org/yaml/) package's Document API — so block scalars,
comments, quoted/escaped strings, flow vs. block lists, and a bare scalar
`tags:` value all parse correctly. The contract that makes round-tripping safe
is *preservation*: only the well-known keys are interpreted and re-emitted; the
Document API carries every other key through verbatim, comments and ordering
intact. (`splitFrontmatter` still owns the `---`-fence delimiting — that's a
frontmatter convention, not YAML.)

**Tags are free-form, not slugs.** A producer's `tags: [BigQuery Table]` is
stored and re-emitted verbatim (trim + whitespace-collapse + length cap only) —
no slugging — so OKF tags round-trip intact.

**One honest fidelity limit:** the frontmatter round-trips byte-stably, but the
*body* of an *edited* doc is re-rendered from BlockNote (`renderBlocksToMarkdown`
— collapses blank lines, drops underline/colour). A clean, unedited git-synced
doc exports its exact imported `source.md` body; only once edited does the lossy
render apply.

## Flows

**Import (git sync)** — `apps/worker/src/git/sync.ts`
Each synced `*.md` is parsed: `title` falls back to the body's H1; `type` /
`description` / `resource` / the raw block land on the doc; `tags` become
additive free-form tags. `source.md` stays the exact repo file (the write-back
baseline); the reindex consumer strips frontmatter before chunking so YAML
isn't embedded as body text.

**Import (paste/upload)** — `apps/web/src/routes/docs-list/ImportDocModal.tsx`
Frontmatter is split client-side; blocks parse from the body only; the metadata
+ raw block are sent to `POST /api/docs`.

**Export** — `GET /api/docs/:id/export` → `apps/worker/src/docs/okf.ts`
`composeOkfExport` emits synthesised frontmatter (rail fields + preserved
unknown keys; `type` defaults to `Document` when unset) followed by the body.
Surfaced as **"Export as OKF (.md)"** in the rail.

**Git write-back** — `apps/worker/src/git/writeback.ts`
`okfReattachForWriteBack` re-attaches refreshed frontmatter around the edited
body, but **only** for docs that were imported *with* frontmatter — a
previously-plain repo file stays plain. No `timestamp` is emitted on write-back
(avoids diff churn; the producer's timestamp is preserved from the raw block).

## Storage

Migration `0025_doc_okf_meta.sql` adds `doc_type`, `description`, `resource`,
`okf_frontmatter` to `documents`. Migration `0026_topic_to_tag.sql` renames the
free-form `doc_tags` / `skill_tags` kind `topic` → `tag` (rebuild + remap;
both are leaf tables, so the §G1 cascade trap does not apply).

## Why this matters

OKF is a young, open standard (v0.1) for the exact problem ctxlayer
exists to solve: shared, curated, agent-facing knowledge. Speaking it natively
— in *and* out — means an org's ctxlayer library is portable: it can be seeded
from, and exported back to, any OKF bundle (a git repo, a tarball, another
tool) with no lock-in. Adopting it early is a deliberate bet on interoperable
knowledge over a proprietary store.
