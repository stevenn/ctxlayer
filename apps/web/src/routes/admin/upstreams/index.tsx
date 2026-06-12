import { Fragment, useCallback, useState } from 'react'
import { Alert, Badge, Button, Group, Text, Title } from '@mantine/core'
import { clickableRow } from '../../../lib/a11y'
import { fetchAdminUpstreams, fetchAdminUpstreamTools } from '../../../lib/api'
import { useLoad } from '../../../lib/use-load'
import { useOAuthFlashBanner } from '../../../lib/use-oauth-banner'
import { explain, type ToolsState } from './helpers'
import { CreateUpstreamModal } from './CreateUpstreamModal'
import { ExpandChevron } from './ExpandChevron'
import { ToolsExpansion } from './ToolsExpansion'
import { UpstreamDrawer } from './UpstreamDrawer'

export function AdminUpstreams() {
  const { data: items, error, reload } = useLoad(fetchAdminUpstreams, [], { explain })
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Expanded upstream ids → lazy-fetched tool cache. Toggled by the
  // per-row chevron; the row's main click still opens the drawer.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [toolsByUpstream, setToolsByUpstream] = useState<Map<string, ToolsState>>(new Map())
  // OAuth callbacks bounced via `return_to=admin` flash a slug or an error
  // code on the URL; surface it and clean the URL.
  const { banner: oauthBanner, clear: clearOauthBanner } = useOAuthFlashBanner()

  // Toggle expand for a row. First time a row is expanded, lazy-fetch
  // its tool cache; subsequent toggles reuse the cached state.
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        return next
      }
      next.add(id)
      // Fire-and-forget fetch on first expand. Skip if we already
      // have a ready/error state cached.
      setToolsByUpstream((cur) => {
        if (cur.has(id) && cur.get(id)!.kind !== 'loading') return cur
        const m = new Map(cur)
        m.set(id, { kind: 'loading' })
        return m
      })
      void fetchAdminUpstreamTools(id).then(
        (resp) =>
          setToolsByUpstream((cur) => {
            const m = new Map(cur)
            m.set(id, {
              kind: 'ready',
              tools: resp.tools,
              attachedSkills: resp.attachedSkills,
              attachedDocs: resp.attachedDocs
            })
            return m
          }),
        (err) =>
          setToolsByUpstream((cur) => {
            const m = new Map(cur)
            m.set(id, { kind: 'error', message: explain(err) })
            return m
          })
      )
      return next
    })
  }, [])

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Upstreams
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New upstream</Button>
      </Group>

      {oauthBanner && (
        <Alert
          color={oauthBanner.kind === 'ok' ? 'green' : 'red'}
          variant="light"
          radius="sm"
          mb="md"
          withCloseButton
          onClose={clearOauthBanner}
        >
          {oauthBanner.message}
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}

      {items && items.length === 0 && (
        <Text c="dimmed">
          No upstreams yet. Click <strong>+ New upstream</strong> to register the first one (e.g.
          Notion HTTP MCP).
        </Text>
      )}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 32 }} aria-label="Expand" />
              <th>Display name</th>
              <th>Slug</th>
              <th>Transport</th>
              <th>Auth</th>
              <th>Tools</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => {
              const open = expandedIds.has(u.id)
              const tools = toolsByUpstream.get(u.id)
              return (
                <Fragment key={u.id}>
                  <tr {...clickableRow(() => setEditingId(u.id))}>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleExpanded(u.id)
                        }}
                        aria-label={open ? 'Collapse tools' : 'Expand tools'}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          userSelect: 'none',
                          display: 'inline-flex'
                        }}
                      >
                        <ExpandChevron open={open} />
                      </button>
                    </td>
                    <td style={{ fontWeight: 500 }}>{u.displayName}</td>
                    <td className="text-muted">
                      <code>{u.slug}</code>
                    </td>
                    <td className="text-muted">{u.transport}</td>
                    <td className="text-muted">{u.authStrategy}</td>
                    <td className="text-muted">{u.toolsCount}</td>
                    <td>
                      <Badge color={u.enabled ? 'green' : 'gray'} variant="light">
                        {u.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </td>
                  </tr>
                  {open && (
                    <tr style={{ background: 'var(--bg-surface)' }}>
                      <td />
                      <td colSpan={6} style={{ padding: '8px 12px' }}>
                        <ToolsExpansion
                          upstreamId={u.id}
                          slug={u.slug}
                          state={tools}
                          onAttachmentsChanged={() => {
                            void fetchAdminUpstreamTools(u.id).then(
                              (resp) =>
                                setToolsByUpstream((cur) => {
                                  const m = new Map(cur)
                                  m.set(u.id, {
                                    kind: 'ready',
                                    tools: resp.tools,
                                    attachedSkills: resp.attachedSkills,
                                    attachedDocs: resp.attachedDocs
                                  })
                                  return m
                                }),
                              () => {
                                /* swallow — chips just won't update */
                              }
                            )
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {createOpen && (
        <CreateUpstreamModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false)
            reload()
            setEditingId(id)
          }}
        />
      )}

      {editingId && (
        <UpstreamDrawer
          upstreamId={editingId}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onDeleted={() => {
            setEditingId(null)
            reload()
          }}
        />
      )}
    </>
  )
}
