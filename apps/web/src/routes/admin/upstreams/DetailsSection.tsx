import { useEffect, useState } from 'react'
import { Button, Group, NumberInput, Select, Stack, Switch, Text, TextInput } from '@mantine/core'
import { isStaticOAuthConfig } from '@ctxlayer/shared'
import type {
  AdminUpstreamRow,
  AuthStrategy,
  SupportedTransport,
  UpstreamAuthConfig
} from '@ctxlayer/shared'
import {
  AUTH_OPTIONS,
  OAUTH_STATIC,
  Section,
  TRANSPORT_OPTIONS,
  formStrategy,
  persistedStrategy,
  type FormAuthStrategy
} from './helpers'
import {
  OAuthClientFields,
  buildStaticOAuth,
  oauthFieldsFromConfig,
  type OAuthClientFieldValues
} from './OAuthClientFields'

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
// Async tools (WI-6): the drawer edits a comma-separated list of native tool
// names; the wire format is `authConfig.asyncTools: string[]`. Empty ⇒ undefined
// ⇒ nothing runs async for this upstream.
function asyncToolsToText(list?: string[]): string {
  return (list ?? []).join(', ')
}
function textToAsyncTools(s: string): string[] | undefined {
  const list = s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  return list.length > 0 ? list : undefined
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
  const [authStrategy, setAuthStrategy] = useState<FormAuthStrategy>(
    formStrategy(row.authStrategy, row.authConfig)
  )
  const [enabled, setEnabled] = useState(row.enabled)
  // Static (pre-registered) OAuth client — for IdPs that don't support DCR
  // (e.g. Entra fronting Azure DevOps). The secret is write-only: the server
  // seals it and never returns it, so it starts blank and
  // `row.clientSecretConfigured` drives the "already set" placeholder.
  const [oauthFields, setOauthFields] = useState<OAuthClientFieldValues>(
    oauthFieldsFromConfig(row.authConfig.oauth)
  )
  // Advanced (WI-1/WI-4) per-upstream overrides.
  const tmo = row.authConfig.timeouts
  const [callSec, setCallSec] = useState<number | ''>(msToSec(tmo?.callMs))
  const [maxCallSec, setMaxCallSec] = useState<number | ''>(msToSec(tmo?.maxCallMs))
  const [listSec, setListSec] = useState<number | ''>(msToSec(tmo?.listMs))
  const [maxRespKb, setMaxRespKb] = useState<number | ''>(
    bytesToKb(row.authConfig.maxResponseBytes)
  )
  const [asyncToolsText, setAsyncToolsText] = useState(asyncToolsToText(row.authConfig.asyncTools))

  // Reset when the row changes (e.g. after save → reload).
  useEffect(() => {
    setDisplayName(row.displayName)
    setTransport(row.transport)
    setUrl(row.url)
    setAuthStrategy(formStrategy(row.authStrategy, row.authConfig))
    setEnabled(row.enabled)
    setOauthFields(oauthFieldsFromConfig(row.authConfig.oauth))
    const t = row.authConfig.timeouts
    setCallSec(msToSec(t?.callMs))
    setMaxCallSec(msToSec(t?.maxCallMs))
    setListSec(msToSec(t?.listMs))
    setMaxRespKb(bytesToKb(row.authConfig.maxResponseBytes))
    setAsyncToolsText(asyncToolsToText(row.authConfig.asyncTools))
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
    const cfg: UpstreamAuthConfig = {
      ...row.authConfig,
      timeouts: hasTimeout ? timeouts : undefined,
      maxResponseBytes: kbToBytes(maxRespKb),
      asyncTools: textToAsyncTools(asyncToolsText)
    }
    if (authStrategy === OAUTH_STATIC) {
      // Pre-registered client: emit the static block from the form. The server
      // re-attaches the sealed secret when `clientSecret` is absent.
      const oauth = buildStaticOAuth(oauthFields)
      if (oauth) cfg.oauth = oauth
    } else if (isStaticOAuthConfig(cfg)) {
      // Switched away from pre-registered (e.g. to plain DCR): drop the static
      // client so the wire no longer detects it as static. A static upstream
      // carries no DCR `client_info`, so nothing worth keeping is lost.
      cfg.oauth = undefined
    }
    return cfg
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
          onChange={(v) => v && setAuthStrategy(v as FormAuthStrategy)}
          allowDeselect={false}
          description={AUTH_OPTIONS.find((o) => o.value === authStrategy)?.description}
        />
        {authStrategy === OAUTH_STATIC && (
          <OAuthClientFields
            values={oauthFields}
            onChange={(patch) => setOauthFields((v) => ({ ...v, ...patch }))}
            secretConfigured={row.clientSecretConfigured}
          />
        )}
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
          <TextInput
            label="Async tools (submit→poll)"
            placeholder="gather_task_context, get_code_map"
            value={asyncToolsText}
            onChange={(e) => setAsyncToolsText(e.currentTarget.value)}
            description="Comma-separated NATIVE tool names that run out-of-band: the call returns a job token immediately and a background worker runs it, so a multi-minute tool survives an interactive client's request cap (e.g. Claude Desktop ~180s). The agent fetches the result with poll_task. Leave blank to run every tool inline. Takes effect on the next MCP session (reconnect the connector)."
          />
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
                authStrategy: persistedStrategy(authStrategy),
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
