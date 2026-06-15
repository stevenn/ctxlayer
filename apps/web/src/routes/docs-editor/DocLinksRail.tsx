import { useNavigate } from 'react-router-dom'
import { Text } from '@mantine/core'
import { fetchDocLinks } from '../../lib/api'
import { useLoad } from '../../lib/use-load'
import { explain } from './helpers'

/**
 * Right-rail "Links" panel: the doc's place in the inter-doc graph.
 *
 * - Incoming references (backlinks) — docs that link TO this one.
 * - Outgoing links — this doc's links, with dangling (unresolved) ones
 *   flagged so a broken reference is visible without opening every link.
 *
 * The graph is rebuilt on reindex, so a just-saved/imported doc populates
 * after its next reindex pass (admin "Reindex search" backfills the library).
 * Reads are open; clicking a row navigates carrying `fromDocId` so the target
 * shows the "← back to source" affordance, same as in-body link clicks.
 */
export function DocLinksRail({ docId }: { docId: string }) {
  const nav = useNavigate()
  const { data } = useLoad((signal) => fetchDocLinks(docId, signal), [docId], { explain })

  const incoming = data?.incoming ?? []
  const outgoing = data?.outgoing ?? []
  const go = (id: string) => nav(`/app/docs/${id}`, { state: { fromDocId: docId } })

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <Header>Incoming references</Header>
      {data === null ? (
        <Muted>Loading…</Muted>
      ) : incoming.length === 0 ? (
        <Muted>No docs link here yet.</Muted>
      ) : (
        <List>
          {incoming.map((d) => (
            <LinkRow key={d.id} title={d.title} onClick={() => go(d.id)} />
          ))}
        </List>
      )}

      {outgoing.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Header>Outgoing links</Header>
          <List>
            {outgoing.map((o) =>
              o.target ? (
                <LinkRow
                  key={o.ref}
                  title={o.target.title}
                  onClick={() => go(o.target!.id)}
                />
              ) : (
                <DanglingRow key={o.ref} ref_={o.ref} />
              )
            )}
          </List>
        </div>
      )}
    </div>
  )
}

function Header({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <Text fz="xs" c="dimmed">
      {children}
    </Text>
  )
}

function List({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
}

function LinkRow({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '4px 6px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        color: 'var(--accent)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {title}
    </button>
  )
}

function DanglingRow({ ref_ }: { ref_: string }) {
  return (
    <div
      title={`Unresolved link: ${ref_} — the target doc is missing or not yet indexed.`}
      style={{
        padding: '4px 6px',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        color: 'var(--text-dim)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      ⚠ <code>{ref_}</code>
    </div>
  )
}
