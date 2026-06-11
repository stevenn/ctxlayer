<!--
DRAFT ctxlayer skill — Azure DevOps.

This is a skill BODY (a markdown playbook), not repo source. Publish it via
admin → Skills (or `ctxlayer draft-skill`), then ATTACH it to the Azure DevOps
upstream so agents see it on `list_upstreams` and load it with `get_skill`.

  - Suggested slug:  sk-azure-devops
  - Suggested title: Azure DevOps — how we use it
  - Attach to:       the ADO upstream (whole-upstream attachment)

Tool names below are REPRESENTATIVE. ctxlayer namespaces every proxied tool as
`<upstream-slug>__<tool>` (e.g. `up-ado__core_list_projects`). The exact set
depends on whether you connect the remote server or the local server behind a
bridge, and on the server version — confirm against the upstream's cached
tools (`list_upstreams` → the ADO entry, or the admin tool browser) before
relying on a specific name.
-->

# Azure DevOps — how we use it

Azure DevOps (ADO) is proxied through ctxlayer with **per-user identity** via
Entra OAuth — you act as *yourself*, with your own ADO permissions. Read
broadly; treat writes as deliberate actions.

## Before you call a tool

- **Org + project are required context.** Most tools need a project; some need
  the org. If the user didn't name one, call the project-list tool
  (`…__core_list_projects`) and confirm rather than guessing.
- **Discover the real tool names once.** Run `list_upstreams` and look at the
  ADO entry's cached tools (or call `tools/list`). The families below are
  stable; the exact suffixes are not.

## Default to read-only

Prefer the read tools; they're safe to fan out:

| Want | Tool family (representative) |
|---|---|
| My assigned work items | `…__wit_work_item` (action `my`) / `…__wit_my_work_items` |
| A work item + its fields | `…__wit_work_item` (`get` / `get_batch`) |
| Run a saved/ad-hoc query (WIQL) | `…__wit_query` / `…__wit_query_by_wiql` |
| PRs needing my review / in a repo | `…__repo_pull_request` (`list`) |
| PR threads + comments | `…__repo_pull_request_thread` (`list`, `list_comments`) |
| File contents at a ref | `…__repo_file` (`get_content`, `list_directory`) |
| Full-text code / work-item / wiki search | `…__search_code` / `…__search_workitem` / `…__search_wiki` |
| Build status, logs, pipeline runs | `…__pipelines_build`, `…__pipelines_run` |

Guidance:
- **Batch reads** when you have several IDs (`get_batch`) instead of N single
  gets — fewer round-trips, less context.
- **Prefer WIQL** (`wit_query`) for anything filtered ("active bugs in area X
  assigned to me") rather than listing then filtering client-side.
- **Search before browse** for "where is X" questions — `search_code` /
  `search_workitem` beat walking directories or backlogs.

## Writes — confirm first

Create/update tools (`…__wit_work_item_write`, `…__repo_pull_request_write`,
`…__wit_work_item_comment_write`, `…__pipelines_write`, `…__wiki_upsert_page`,
test-plan writes) mutate real org state. Before any write:

1. **Restate the intent** to the user (what, where, which project/area/iteration)
   and get an explicit go-ahead for anything destructive or org-visible.
2. **Set required fields** — work items need a type + title + area/iteration
   path; a PR needs source/target branches.
3. **Link, don't orphan** — when creating a work item for a PR or commit, use
   the link/artifact-link write so it's traceable.
4. There is generally **no hard delete** for work items via the API — cancel /
   set state, or do it in the UI. Don't assume a delete tool exists.

## Conventions for this org

> Fill in the specifics your org actually uses — they're what make this skill
> worth loading. For example:
>
> - **Projects / repos** we work in: `…`
> - **Area paths** and what they mean: `…`
> - **Iteration / sprint** cadence + how to find the current one
>   (`…__work` `get_team_settings` → default iteration).
> - **Work-item types + states** we use (e.g. Bug/User Story/Task; New →
>   Active → Resolved → Closed) and the transitions that are allowed.
> - **PR etiquette**: required reviewers, autocomplete, vote semantics.
> - **Labels / tags** conventions.

## Gotchas

- **Attachments come back base64** (filename + MIME) — decode before showing.
- **Read-only mode** may be enforced server-side (the operator can pin the
  upstream to read-only); a write tool 403/absence there is by design, not a
  bug.
- **Pagination**: list tools page; don't claim "that's all" off the first page
  for large repos/backlogs.
- Errors from the proxy surface as a generic `upstream_error` to you — the real
  ADO message is server-side only. Re-state what you tried; don't invent a
  cause.
