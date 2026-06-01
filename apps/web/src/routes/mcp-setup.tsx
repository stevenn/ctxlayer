import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  Title
} from '@mantine/core'
import { fetchConfig } from '../lib/api'

/**
 * "Connect your AI tool" page. Pulls the live `publicBaseUrl` from
 * `/api/config` so the snippets always render the right URL — works
 * the same on localhost dev, workers.dev, and any custom domain we
 * point at the worker later.
 *
 * Auth is OAuth 2.1 (Dynamic Client Registration + PKCE) per the MCP
 * spec, served at `/oauth/*` + `/.well-known/oauth-authorization-server`.
 * Clients that speak that flow get auto-provisioned client_ids; we don't
 * hand out static credentials.
 */
export function McpSetup() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchConfig(ctrl.signal).then(
      (cfg) => {
        if (!ctrl.signal.aborted) setBaseUrl(cfg.publicBaseUrl.replace(/\/$/, ''))
      },
      (err) => {
        if (ctrl.signal.aborted) return
        setError('Could not load deployment config.')
        console.error(err)
      }
    )
    return () => ctrl.abort()
  }, [])

  if (error) {
    return (
      <Alert color="red" variant="light" radius="sm">
        {error}
      </Alert>
    )
  }
  if (!baseUrl) {
    return <Text c="dimmed">Loading…</Text>
  }

  const mcpUrl = `${baseUrl}/mcp`

  return (
    <Stack gap="xl">
      <div>
        <Title order={2} fz={20} fw={600} mb={6}>
          Connect ctxlayer to your AI tool
        </Title>
        <Text c="dimmed" fz="sm">
          ctxlayer is a remote MCP server. Most modern clients can connect over streamable HTTP and
          authenticate via OAuth 2.1 (Dynamic Client Registration + PKCE) — no copy-paste of
          long-lived secrets.
        </Text>
      </div>

      <Section
        title="MCP endpoint"
        badge="auto-detect"
        body="If your client supports OAuth-protected remote MCP servers, this is the only URL it needs."
      >
        <Snippet value={mcpUrl} />
      </Section>

      <Section
        title="Claude (web app)"
        body={
          <>
            In <strong>Settings → Connectors → Add custom connector</strong>, paste the URL above.
            Claude walks you through GitHub / Google sign-in on first use and remembers the
            connection.
          </>
        }
      />

      <Section
        title="Claude Desktop / Claude Code"
        badge="mcp-remote shim"
        body={
          <>
            Claude Desktop and Claude Code speak <em>local stdio</em> MCP only, so we tunnel through{' '}
            <Anchor href="https://github.com/geelen/mcp-remote" target="_blank">
              mcp-remote
            </Anchor>
            . Drop this into <code>~/.claude.json</code> (Code) or the Desktop config file (Settings
            → Developer → Edit config):
          </>
        }
      >
        <Snippet
          lang="json"
          value={JSON.stringify(
            {
              mcpServers: {
                ctxlayer: {
                  command: 'npx',
                  args: ['-y', 'mcp-remote', mcpUrl]
                }
              }
            },
            null,
            2
          )}
        />
      </Section>

      <Section
        title="Cursor / Windsurf / Zed / VS Code"
        body={
          <>
            Most editor-side MCP integrations accept a remote URL directly. The shape varies —
            Cursor uses <code>~/.cursor/mcp.json</code>, others have a settings UI. The connection
            record is always the same:
          </>
        }
      >
        <Snippet
          lang="json"
          value={JSON.stringify({ mcpServers: { ctxlayer: { url: mcpUrl } } }, null, 2)}
        />
      </Section>

      <Section
        title="Upstream credentials"
        body={
          <>
            ctxlayer proxies third-party MCP upstreams (Notion, Linear, etc.) using{' '}
            <em>per-user</em> credentials. After connecting, head to{' '}
            <Anchor component={Link} to="/upstreams">
              /upstreams
            </Anchor>{' '}
            to authorise each upstream — OAuth where the upstream supports it, or a paste-in bearer
            token as a fallback.
          </>
        }
      />
    </Stack>
  )
}

// ----- bits --------------------------------------------------------------

function Section({
  title,
  body,
  badge,
  children
}: {
  title: string
  body: React.ReactNode
  badge?: string
  children?: React.ReactNode
}) {
  return (
    <div>
      <Group gap="xs" align="center" mb={4}>
        <Title order={3} fz={15} fw={600}>
          {title}
        </Title>
        {badge && (
          <Badge size="xs" variant="light" color="gray">
            {badge}
          </Badge>
        )}
      </Group>
      <Text c="dimmed" fz="sm" mb={children ? 'xs' : 0}>
        {body}
      </Text>
      {children}
    </div>
  )
}

function Snippet({ value, lang }: { value: string; lang?: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <Code
        block
        style={{
          fontSize: 12,
          whiteSpace: 'pre',
          paddingRight: 84
        }}
      >
        {value}
      </Code>
      <div style={{ position: 'absolute', top: 6, right: 6 }}>
        <CopyButton value={value} timeout={1500}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              variant={copied ? 'filled' : 'default'}
              color={copied ? 'teal' : undefined}
              onClick={copy}
              aria-label={lang ? `Copy ${lang}` : 'Copy'}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </div>
    </div>
  )
}
