import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Group, PasswordInput, Stack, Text } from '@mantine/core'
import type { GitDocStatus } from '@ctxlayer/shared'
import { prepareGitReviewUrl, proposeGitPullRequest, putGitUserCredential } from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'
import { useBusyAction } from '../../lib/use-busy'
import { explain } from './helpers'

/**
 * Right-rail panel for git-synced docs. Reads as a plain sentence ("Synced
 * from <repo> · <branch>") + a human sync status, then the write actions.
 *
 * Smart connect: the per-user Connect controls only appear when this source's
 * WRITE strategy is per-user (user_oauth / user_bearer) AND you haven't
 * connected — that's the only case where your own token is needed to author a
 * PR. Shared-token sources never show Connect (the org token authors). The
 * OAuth *client* + write strategy themselves are configured by an admin on the
 * connection, not here.
 */
const STATE_LABEL: Record<string, string> = {
  clean: 'In sync',
  local_edits: 'Local edits — not proposed yet',
  pr_open: 'Pull request open',
  conflict: 'Conflict — remote changed'
}

export function GitPanel({
  status,
  docId,
  canEdit,
  getMarkdown,
  onRefresh,
  onRevert
}: {
  status: GitDocStatus
  docId: string
  canEdit: boolean
  getMarkdown: () => Promise<string>
  onRefresh: () => Promise<void>
  /** Discard local edits and re-import the repo version (owner handles
   * provider teardown + reload — see docs-editor/index.tsx). */
  onRevert: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [msg, setMsg] = useState<string | null>(null)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const { busy, run: withBusy } = useBusyAction({
    explain,
    // success + failure share the one `msg` banner
    setError: (m) => {
      if (m) setMsg(m)
    },
    onStart: () => {
      setMsg(null)
      setReviewUrl(null)
    }
  })

  // Surface the result of the OAuth round-trip (the callback bounces back to
  // /app/docs/:id?git_oauth_connected=… or ?git_oauth_error=…), then clean the
  // query so a reload doesn't re-show it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('git_oauth_connected')
    const err = params.get('git_oauth_error')
    if (!connected && !err) return
    setMsg(
      connected
        ? 'Connected — your commits will be authored as you.'
        : `OAuth connect failed (${err}).`
    )
    params.delete('git_oauth_connected')
    params.delete('git_oauth_error')
    const qs = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const stateKey = status.syncState ?? 'clean'
  const stateColor =
    stateKey === 'conflict'
      ? 'red'
      : stateKey === 'pr_open'
        ? 'blue'
        : stateKey === 'local_edits'
          ? 'yellow'
          : 'green'

  // Write-back is disabled when the source carries HTML the editor can't
  // round-trip — proposing would silently drop it, so the doc is edit-in-git.
  const canPropose = canEdit && !status.htmlRoundtripUnsafe
  // Per-user write auth: needed only for user_* write strategies.
  const needsPersonalAuth =
    status.writeStrategy === 'user_oauth' || status.writeStrategy === 'user_bearer'
  const showAuth = canPropose && needsPersonalAuth

  const propose = () =>
    withBusy(async () => {
      const md = await getMarkdown()
      const res = await proposeGitPullRequest(docId, md)
      setMsg(
        res.outcome === 'noop'
          ? 'No changes vs the synced version.'
          : res.outcome === 'opened'
            ? 'Pull request opened.'
            : 'Pull request updated.'
      )
      await onRefresh()
    }, 'Propose')

  const reviewInBrowser = () =>
    withBusy(async () => {
      const md = await getMarkdown()
      const res = await prepareGitReviewUrl(docId, md)
      if (res.redirectUrl) {
        setReviewUrl(res.redirectUrl)
        setMsg('Branch pushed — open the New-PR page to review and create it:')
      } else {
        setMsg('No changes vs the synced version.')
      }
    }, 'Review')

  async function connect() {
    if (!token.trim()) return
    await withBusy(async () => {
      await putGitUserCredential(status.gitSourceId, token.trim())
      setToken('')
      setConnectOpen(false)
      setMsg('Token connected — your commits will be authored as you.')
      await onRefresh()
    }, 'Connect')
  }

  function startOauth() {
    window.location.href =
      `/api/git-sources/${encodeURIComponent(status.gitSourceId)}/oauth/start` +
      `?doc=${encodeURIComponent(docId)}`
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        Git source
      </div>
      <Stack gap={6}>
        <Text fz="xs">
          Synced from <code>{status.sourceSlug}</code> · branch <code>{status.branch}</code>
        </Text>
        <a href={status.webUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          View source on {status.provider} ↗
        </a>
        <Group gap={6}>
          <Text fz="xs" c="dimmed">
            Status
          </Text>
          <Badge size="xs" variant="light" color={stateColor}>
            {STATE_LABEL[stateKey] ?? stateKey}
          </Badge>
        </Group>
        {status.pr && (
          <a href={status.pr.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            PR #{status.pr.providerPrId} ({status.pr.state}) ↗
          </a>
        )}

        {msg && (
          <Alert color="gray" variant="light" radius="sm" p={6}>
            <Text fz="xs">{msg}</Text>
            {reviewUrl && (
              <a
                href={reviewUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, display: 'inline-block', marginTop: 4 }}
              >
                Open New-PR page on {status.provider} ↗
              </a>
            )}
          </Alert>
        )}

        {canEdit && status.htmlRoundtripUnsafe && (
          <Alert color="yellow" variant="light" radius="sm" p={6}>
            <Text fz="xs">
              This doc uses HTML the editor can&apos;t round-trip (comments, anchors,{' '}
              <code>&lt;details&gt;</code>…). Editing here would drop it, so proposing a change is
              disabled — edit it directly in {status.provider} via the link above.
            </Text>
          </Alert>
        )}
        {canPropose && (
          <Button size="xs" variant="default" onClick={propose} loading={busy}>
            Propose change (open PR)
          </Button>
        )}
        {canPropose && (
          <Button size="compact-xs" variant="subtle" onClick={reviewInBrowser} loading={busy}>
            Review &amp; create in {status.provider}…
          </Button>
        )}
        {/* Revert = the other way out of local_edits/conflict/pr_open:
            discard what's here, take the repo's version. */}
        {canEdit && stateKey !== 'clean' && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            loading={busy}
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: 'Revert to git version?',
                message:
                  `Discard the local edits on this doc and re-import ` +
                  `${status.path} from ${status.sourceSlug}? The page reloads with the ` +
                  `repo's version; earlier revisions stay in the doc history.` +
                  (stateKey === 'pr_open'
                    ? ' An open PR is NOT closed by this — abandon it in the provider too.'
                    : ''),
                confirmLabel: 'Revert',
                danger: true
              })
              if (ok) await onRevert()
            }}
          >
            Revert to git version…
          </Button>
        )}

        {/* Smart connect: only for per-user write strategies. */}
        {showAuth && status.currentUserConnected && (
          <Text fz="xs" c="dimmed">
            ✓ Connected — PRs are authored as you.{' '}
            {status.oauthConfigured && (
              <Text
                component="a"
                fz="xs"
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  startOauth()
                }}
              >
                Reconnect
              </Text>
            )}
          </Text>
        )}
        {showAuth && !status.currentUserConnected && (
          <>
            <Text fz="xs" c="dimmed">
              Connect so your pull requests are authored as you:
            </Text>
            {status.oauthConfigured && (
              <Button size="xs" variant="default" onClick={startOauth}>
                Connect via {status.provider} (OAuth)
              </Button>
            )}
            {!connectOpen && (
              <Button size="compact-xs" variant="subtle" onClick={() => setConnectOpen(true)}>
                Connect a personal token…
              </Button>
            )}
            {connectOpen && (
              <Stack gap={4}>
                <PasswordInput
                  size="xs"
                  aria-label="Personal access token"
                  placeholder="Personal access token (repo write)…"
                  value={token}
                  onChange={(e) => setToken(e.currentTarget.value)}
                  disabled={busy}
                />
                <Group justify="flex-end" gap={4}>
                  <Button size="compact-xs" variant="subtle" onClick={() => setConnectOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="compact-xs" onClick={connect} disabled={!token.trim() || busy}>
                    Connect
                  </Button>
                </Group>
              </Stack>
            )}
          </>
        )}
      </Stack>
    </div>
  )
}
