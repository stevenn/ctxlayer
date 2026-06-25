import { Link } from 'react-router-dom'
import {
  Alert,
  Anchor,
  Button,
  Code,
  CopyButton,
  List,
  Stack,
  Text,
  Title
} from '@mantine/core'
import { fetchConfig } from '../lib/api'
import { useLoad } from '../lib/use-load'

/**
 * "Connect your AI tool" page. Pulls the live `mcpBaseUrl` from
 * `/api/config` so the snippets always render the right URL — works
 * the same on localhost dev, workers.dev, and any custom domain we
 * point at the worker later. `mcpBaseUrl` is the MCP surface's host,
 * which on Access deployments is a dedicated `mcp.<tenant>` domain
 * separate from the (fully gated) browser host; it falls back to
 * `publicBaseUrl` on single-host deployments.
 *
 * Auth is OAuth 2.1 (Dynamic Client Registration + PKCE) per the MCP
 * spec, served at `/oauth/*` + `/.well-known/oauth-authorization-server`.
 * Clients that speak that flow get auto-provisioned client_ids; we don't
 * hand out static credentials.
 */
export function McpSetup() {
  const { data: baseUrl, error } = useLoad(
    async (signal) => {
      try {
        const cfg = await fetchConfig(signal)
        // Prefer the dedicated MCP host; fall back to publicBaseUrl when a
        // deployment doesn't set one (or an older server omits the field).
        return (cfg.mcpBaseUrl || cfg.publicBaseUrl).replace(/\/$/, '')
      } catch (err) {
        if (!signal?.aborted) console.error(err)
        throw err
      }
    },
    [],
    { explain: () => 'Could not load deployment config.' }
  )

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
          authenticate via OAuth 2.1 (Dynamic Client Registration + PKCE).
        </Text>
      </div>

      <Section
        title="MCP endpoint"
        body="If your client supports OAuth-protected remote MCP servers, this is the only URL it needs."
      >
        <Snippet value={mcpUrl} />
      </Section>

      <Section
        title="Claude Desktop and Web app"
        body={
          <>
            In <strong>Settings → Connectors → Customize → Add custom connector</strong>, paste the MCP endpoint
            above. Claude connects to the remote server directly and walks you through sign-in.
          </>
        }
      />

      <Section
        title="Claude Code"
        body={
          <>
            Claude Code speaks remote MCP over streamable HTTP directly. Add ctxlayer with:
          </>
        }
      >
        <Snippet lang="bash" value={`claude mcp add --transport http ctxlayer ${mcpUrl}`} />
        <Text c="dimmed" fz="sm" mt="xs">
          Then run <code>/mcp</code> in a session and pick <strong>ctxlayer → Authenticate</strong>{' '}
          to complete sign-in in your browser.
        </Text>
      </Section>

      <Section
        title="Deploy org-wide (managed MCP)"
        body={
          <>
            To push ctxlayer to every Claude Code user without each one running{' '}
            <code>claude mcp add</code>, drop a <code>managed-mcp.json</code> at the system path for
            their OS (via MDM / Group Policy / your fleet tooling):
          </>
        }
      >
        <List size="sm" spacing={2} mb="xs">
          <List.Item>
            macOS — <Code>/Library/Application Support/ClaudeCode/managed-mcp.json</Code>
          </List.Item>
          <List.Item>
            Linux / WSL — <Code>/etc/claude-code/managed-mcp.json</Code>
          </List.Item>
          <List.Item>
            Windows — <Code>{'C:\\Program Files\\ClaudeCode\\managed-mcp.json'}</Code>
          </List.Item>
        </List>
        <Snippet
          lang="json"
          value={JSON.stringify(
            { mcpServers: { ctxlayer: { type: 'http', url: mcpUrl } } },
            null,
            2
          )}
        />
        <Text c="dimmed" fz="xs" mt="xs">
          A <code>managed-mcp.json</code> takes exclusive control — Claude Code loads only the servers
          it lists, and users can't add or remove servers while it's present.
        </Text>
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
        title="What about upstream MCP credentials?"
        body={
          <>
            ctxlayer proxies third-party MCP upstreams (Notion, Linear, etc.) using{' '}
            <em>per-user</em> (OAuth or personal access token) or <em>shared</em> credentials. After connecting, head to{' '}
            <Anchor component={Link} to="/app/upstreams">
              Upstreams
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

// Deliberately NOT the shared admin-bits Section: this page uses a larger
// titled prose section (Title + body), not the uppercase micro-label.
function Section({
  title,
  body,
  children
}: {
  title: string
  body: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div>
      <Title order={3} fz={15} fw={600} mb={4}>
        {title}
      </Title>
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
