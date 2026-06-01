import { useEffect, useState } from 'react'
import { Button, Group, NumberInput, Select, Stack, Switch, Text, TextInput } from '@mantine/core'
import type {
  AdminUpstreamRow,
  AuthStrategy,
  SupportedTransport,
  UpstreamAuthConfig
} from '@ctxlayer/shared'
import { AUTH_OPTIONS, Section, TRANSPORT_OPTIONS } from './helpers'

// Advanced-field conversions (WI-1/WI-4). The drawer edits seconds / KB;
// the wire format is ms / bytes. Blank / non-positive ⇒ undefined ⇒ the
// upstream falls back to the global default.
function msToSec(ms?: number): number | '' {
  return ms == null ? '' : Math.round(ms / 1000)
}
function bytesToKb(b?: number): number | '' {
  return b == null ? '' : Math.round(b / 1024)
}
function secToMs(v: number | ''): number | undefined {
  return v === '' || v <= 0 ? undefined : Math.round(v * 1000)
}
function kbToBytes(v: number | ''): number | undefined {
  return v === '' || v <= 0 ? undefined : Math.round(v * 1024)
}

export function DetailsSection({
  row,
  busy,
  onSave,
  onDelete
}: {
  row: AdminUpstreamRow
  busy: boolean
  onSave: (patch: {
    displayName?: string
    transport?: SupportedTransport
    url?: string
    authStrategy?: AuthStrategy
    enabled?: boolean
    authConfig?: UpstreamAuthConfig
  }) => void
  onDelete: () => void
}) {
  const [displayName, setDisplayName] = useState(row.displayName)
  const [transport, setTransport] = useState<SupportedTransport>(row.transport)
  const [url, setUrl] = useState(row.url)
  const [authStrategy, setAuthStrategy] = useState<AuthStrategy>(row.authStrategy)
  const [enabled, setEnabled] = useState(row.enabled)
  // Advanced (WI-1/WI-4) per-upstream overrides.
  const tmo = row.authConfig.timeouts
  const [callSec, setCallSec] = useState<number | ''>(msToSec(tmo?.callMs))
  const [maxCallSec, setMaxCallSec] = useState<number | ''>(msToSec(tmo?.maxCallMs))
  const [listSec, setListSec] = useState<number | ''>(msToSec(tmo?.listMs))
  const [maxRespKb, setMaxRespKb] = useState<number | ''>(
    bytesToKb(row.authConfig.maxResponseBytes)
  )

  // Reset when the row changes (e.g. after save → reload).
  useEffect(() => {
    setDisplayName(row.displayName)
    setTransport(row.transport)
    setUrl(row.url)
    setAuthStrategy(row.authStrategy)
    setEnabled(row.enabled)
    const t = row.authConfig.timeouts
    setCallSec(msToSec(t?.callMs))
    setMaxCallSec(msToSec(t?.maxCallMs))
    setListSec(msToSec(t?.listMs))
    setMaxRespKb(bytesToKb(row.authConfig.maxResponseBytes))
  }, [row])

  function buildAuthConfig(): UpstreamAuthConfig {
    const timeouts = {
      callMs: secToMs(callSec),
      maxCallMs: secToMs(maxCallSec),
      listMs: secToMs(listSec)
    }
    const hasTimeout =
      timeouts.callMs !== undefined ||
      timeouts.maxCallMs !== undefined ||
      timeouts.listMs !== undefined
    return {
      ...row.authConfig,
      timeouts: hasTimeout ? timeouts : undefined,
      maxResponseBytes: kbToBytes(maxRespKb)
    }
  }

  return (
    <Section title="Details">
      <Stack gap="xs">
        <TextInput
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <TextInput
          label="Slug"
          value={row.slug}
          disabled
          description="Slugs can't be renamed — agents would lose tool references."
        />
        <Select
          label="Transport"
          data={TRANSPORT_OPTIONS}
          value={transport}
          onChange={(v) => v && setTransport(v as SupportedTransport)}
          allowDeselect={false}
        />
        <TextInput
          label="Upstream MCP URL"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        <Select
          label="Auth strategy"
          data={AUTH_OPTIONS.map((o) => ({
            value: o.value,
            label: o.enabled ? o.label : `${o.label} (M5)`,
            disabled: !o.enabled
          }))}
          value={authStrategy}
          onChange={(v) => v && setAuthStrategy(v as AuthStrategy)}
          allowDeselect={false}
          description={AUTH_OPTIONS.find((o) => o.value === authStrategy)?.description}
        />
        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          description="Disabled upstreams are hidden from /upstreams and never appear in tools/list."
        />
        <Stack
          gap={6}
          p="sm"
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 8
          }}
        >
          <Text fz="xs" fw={600}>
            Advanced — resilience
          </Text>
          <Text fz="xs" c="dimmed">
            Per-upstream overrides. Blank = defaults (base call 150s, hard ceiling 300s, tools/list
            60s, response cap 256&nbsp;KB). A long call blocks this MCP session serially — every
            other tool queues behind it, so raise the call timeouts only where genuinely needed.
          </Text>
          <Group gap="xs" grow>
            <NumberInput
              label="Base call timeout (s)"
              placeholder="150"
              min={1}
              value={callSec}
              onChange={(v) => setCallSec(typeof v === 'number' ? v : '')}
            />
            <NumberInput
              label="Hard call ceiling (s)"
              placeholder="300"
              min={1}
              value={maxCallSec}
              onChange={(v) => setMaxCallSec(typeof v === 'number' ? v : '')}
            />
          </Group>
          <Group gap="xs" grow>
            <NumberInput
              label="tools/list timeout (s)"
              placeholder="60"
              min={1}
              value={listSec}
              onChange={(v) => setListSec(typeof v === 'number' ? v : '')}
            />
            <NumberInput
              label="Response cap (KB)"
              placeholder="256"
              min={1}
              value={maxRespKb}
              onChange={(v) => setMaxRespKb(typeof v === 'number' ? v : '')}
            />
          </Group>
        </Stack>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
          <Button
            onClick={() =>
              onSave({
                displayName,
                transport,
                url,
                authStrategy,
                enabled,
                authConfig: buildAuthConfig()
              })
            }
            loading={busy}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}
