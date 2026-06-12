import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Group, PasswordInput, Stack, Text } from '@mantine/core'
import type { GitDocStatus } from '@ctxlayer/shared'
import { prepareGitReviewUrl, proposeGitPullRequest, putGitUserCredential } from '../../lib/api'
import { explain } from './helpers'

/**
 * Right-rail panel for git-synced docs: repo deep-link, sync state, open
 * PR, and a "propose change" button that converts the live editor to
 * markdown and opens/refreshes a write-back PR. Optionally connect a
 * personal token so the commit is authored as you.
 */
export function GitPanel({
  status,
  docId,
  canEdit,
  getMarkdown,
  onRefresh
}: {
  status: GitDocStatus
  docId: string
  canEdit: boolean
  getMarkdown: () => Promise<string>
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)

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
        ? 'Connected via OAuth — your commits will be authored as you.'
        : `OAuth connect failed (${err}).`
    )
    params.delete('git_oauth_connected')
    params.delete('git_oauth_error')
    const qs = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const stateColor =
    status.syncState === 'conflict'
      ? 'red'
      : status.syncState === 'pr_open'
        ? 'blue'
        : status.syncState === 'local_edits'
          ? 'yellow'
          : 'green'

  async function propose() {
    setBusy(true)
    setMsg(null)
    setReviewUrl(null)
    try {
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
    } catch (err) {
      setMsg(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function reviewInBrowser() {
    setBusy(true)
    setMsg(null)
    setReviewUrl(null)
    try {
      const md = await getMarkdown()
      const res = await prepareGitReviewUrl(docId, md)
      if (res.redirectUrl) {
        setReviewUrl(res.redirectUrl)
        setMsg('Branch pushed — open the New-PR page to review and create it:')
      } else {
        setMsg('No changes vs the synced version.')
      }
    } catch (err) {
      setMsg(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    if (!token.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      await putGitUserCredential(status.gitSourceId, token.trim())
      setToken('')
      setConnectOpen(false)
      setMsg('Token connected — your commits will be authored as you.')
    } catch (err) {
      setMsg(explain(err))
    } finally {
      setBusy(false)
    }
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
        Git · {status.provider}
      </div>
      <Stack gap={6}>
        <Text fz="xs" c="dimmed">
          <code>{status.sourceSlug}</code> · {status.branch}
        </Text>
        <a href={status.webUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          View source on {status.provider} ↗
        </a>
        <Group gap={6}>
          <Text fz="xs" c="dimmed">
            State
          </Text>
          <Badge size="xs" variant="light" color={stateColor}>
            {status.syncState ?? 'clean'}
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
        {canEdit && (
          <Button size="xs" variant="default" onClick={propose} loading={busy}>
            Propose change (open PR)
          </Button>
        )}
        {canEdit && (
          <Button size="compact-xs" variant="subtle" onClick={reviewInBrowser} loading={busy}>
            Review &amp; create in {status.provider}…
          </Button>
        )}
        {canEdit && status.oauthConfigured && (
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              window.location.href =
                `/api/git-sources/${encodeURIComponent(status.gitSourceId)}/oauth/start` +
                `?doc=${encodeURIComponent(docId)}`
            }}
          >
            Connect via {status.provider} (OAuth)
          </Button>
        )}
        {canEdit && !connectOpen && (
          <Button size="compact-xs" variant="subtle" onClick={() => setConnectOpen(true)}>
            Connect a personal token…
          </Button>
        )}
        {canEdit && connectOpen && (
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
      </Stack>
    </div>
  )
}
