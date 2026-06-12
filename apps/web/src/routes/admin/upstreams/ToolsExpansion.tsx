import { useState } from 'react'
import { Alert, Badge, Button, Group, Stack, Text, Tooltip } from '@mantine/core'
import { mangleToolName } from '@ctxlayer/shared'
import { relativeTime } from '../../../lib/time'
import type { ToolsState } from './helpers'
import { UpstreamSkillAttachModal } from './AttachModal'

/**
 * Body of the expanded tools row. Three states:
 *  - loading: first fetch in flight
 *  - error:   fetch failed — show inline alert
 *  - ready:   render a compact nested table of cached tools
 *
 * The agent-visible name is computed client-side via `mangleToolName`
 * — same rule the worker uses to register the tool with the MCP
 * server, so the value here matches exactly what the model sees.
 */
export function ToolsExpansion({
  upstreamId,
  slug,
  state,
  onAttachmentsChanged
}: {
  upstreamId: string
  slug: string
  state: ToolsState | undefined
  onAttachmentsChanged: () => void
}) {
  const [attachOpen, setAttachOpen] = useState<{ toolName: string } | null>(null)

  if (!state || state.kind === 'loading') {
    return (
      <Text c="dimmed" fz="xs">
        Loading tools…
      </Text>
    )
  }
  if (state.kind === 'error') {
    return (
      <Alert color="red" variant="light" radius="sm">
        {state.message}
      </Alert>
    )
  }
  return (
    <>
      {/* Whole-upstream attachments (tool_name='') */}
      <Group justify="space-between" align="flex-start" mb="xs">
        <div style={{ minWidth: 0 }}>
          <Text fz="xs" fw={600} c="dimmed" mb={4}>
            Attached to this upstream (whole upstream)
          </Text>
          {state.attachedSkills.length === 0 && state.attachedDocs.length === 0 ? (
            <Text fz="xs" c="dimmed">
              No skills or docs attached to the upstream root.
            </Text>
          ) : (
            <Group gap={6}>
              {state.attachedSkills.map((s) => (
                <Badge
                  key={`s-${s.slug}`}
                  color="violet"
                  variant="light"
                  size="sm"
                  title={`Skill: ${s.title}`}
                >
                  🧠 {s.title}
                </Badge>
              ))}
              {state.attachedDocs.map((d) => (
                <Badge
                  key={`d-${d.slug}`}
                  color="blue"
                  variant="light"
                  size="sm"
                  title={`Doc: ${d.title}`}
                >
                  📄 {d.title}
                </Badge>
              ))}
            </Group>
          )}
        </div>
        <Button size="xs" variant="default" onClick={() => setAttachOpen({ toolName: '' })}>
          Attach skill
        </Button>
      </Group>

      {state.tools.length === 0 ? (
        <Text c="dimmed" fz="xs">
          No tools cached yet. Open the upstream drawer and click <strong>Refresh tools</strong> to
          populate.
        </Text>
      ) : (
        <table className="data-table" style={{ marginTop: 0 }}>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Agent-visible name</th>
              <th style={{ width: '16%' }}>Upstream tool</th>
              <th>Description</th>
              <th style={{ width: '24%' }}>Attached / schema</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {state.tools.map((t) => (
              <tr key={t.toolName}>
                <td>
                  <code style={{ fontSize: 11 }}>{mangleToolName(slug, t.toolName)}</code>
                </td>
                <td className="text-muted">
                  <code style={{ fontSize: 11 }}>{t.toolName}</code>
                </td>
                <td className="text-muted" style={{ fontSize: 12 }}>
                  {t.description ?? <span style={{ opacity: 0.5 }}>—</span>}
                </td>
                <td>
                  <Stack gap={2}>
                    <Group gap={4}>
                      {t.attachedSkills.map((s) => (
                        <Badge
                          key={`ts-${s.slug}`}
                          color="violet"
                          variant="light"
                          size="xs"
                          title={`Skill: ${s.title}`}
                        >
                          🧠 {s.title}
                        </Badge>
                      ))}
                      {t.attachedDocs.map((d) => (
                        <Badge
                          key={`td-${d.slug}`}
                          color="blue"
                          variant="light"
                          size="xs"
                          title={`Doc: ${d.title}`}
                        >
                          📄 {d.title}
                        </Badge>
                      ))}
                    </Group>
                    {t.lastSchemaChangeAt ? (
                      <Tooltip
                        label={
                          t.lastDiffSummary ??
                          'Schema hash changed but no per-property diff was recorded for this refresh.'
                        }
                        multiline
                        maw={360}
                        withArrow
                        position="top-start"
                      >
                        <Text fz={10} c="yellow" style={{ cursor: 'help' }}>
                          ⚠ schema changed {relativeTime(t.lastSchemaChangeAt, '')}
                        </Text>
                      </Tooltip>
                    ) : null}
                  </Stack>
                </td>
                <td>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setAttachOpen({ toolName: t.toolName })}
                  >
                    Attach
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {attachOpen && (
        <UpstreamSkillAttachModal
          upstreamId={upstreamId}
          upstreamSlug={slug}
          toolName={attachOpen.toolName}
          onClose={() => setAttachOpen(null)}
          onAttached={() => {
            setAttachOpen(null)
            onAttachmentsChanged()
          }}
        />
      )}
    </>
  )
}
