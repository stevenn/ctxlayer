/**
 * One Durable Object per document. Realtime collab over the standard
 * y-websocket wire protocol with the WebSocket Hibernation API.
 *
 * Wire format (matches yjs/y-websocket so clients can stay generic):
 *   [type: varUint, payload...]
 *   type=0  Sync       (delegated to y-protocols/sync)
 *   type=1  Awareness  (encoded by y-protocols/awareness)
 *   type=3  QueryAwareness  (empty payload; reply with full awareness)
 *
 * Lifecycle:
 *   - Parent worker authenticates the upgrade (session cookie +
 *     canEditDoc / open-read), then forwards to this DO. The DO never
 *     re-checks auth on subsequent messages because it never *applies*
 *     write messages from sockets that came in tagged read-only.
 *   - With WS Hibernation, the JS instance can be evicted between
 *     events while sockets stay open. On the next message we
 *     reconstruct, lazy-load the Y.Doc from R2, and then send a
 *     syncStep1 to every still-attached socket asking them to resync
 *     any updates they applied between the last R2 write and the
 *     eviction. This closes the "lost in-memory updates" window.
 *   - On every applied update we schedule an R2 snapshot write
 *     (coalesced: one inflight at a time, latest-wins). This means
 *     R2 always lags the live Y.Doc by at most one write latency.
 *     For our doc sizes a write is ~50-150ms and well under one cent
 *     per active hour even at heavy typing rates.
 */

import { DurableObject } from 'cloudflare:workers'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Env } from '../env'
import { readYjsSnapshot, writeYjsSnapshot } from '../storage/docs-r2'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

// Sentinel origin for the R2 → Y.Doc rehydrate. The update observer
// checks this so initial load doesn't re-broadcast or schedule a
// duplicate write of the bytes we just read.
const LOAD_ORIGIN = Symbol('doc-room-do.load')

interface SocketAttachment {
  userId: string
  canEdit: boolean
}

export class DocRoomDO extends DurableObject<Env> {
  private doc: Y.Doc | null = null
  private awareness: awarenessProtocol.Awareness | null = null
  private docId: string | null = null
  private loadPromise: Promise<void> | null = null

  // R2 snapshot coalescing: at most one write inflight; latest pending
  // bytes win when the current write completes.
  private writeInFlight: Promise<void> | null = null
  private writePending: Uint8Array | null = null

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const url = new URL(req.url)
    const docId = url.searchParams.get('docId')
    if (!docId) return new Response('missing docId', { status: 400 })
    const userId = req.headers.get('x-ctx-user-id') ?? ''
    const canEdit = req.headers.get('x-ctx-can-edit') === '1'
    if (!userId) return new Response('missing user', { status: 401 })

    await this.ctx.storage.put('docId', docId)
    this.docId = docId

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.serializeAttachment({ userId, canEdit } satisfies SocketAttachment)
    this.ctx.acceptWebSocket(server)

    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    if (typeof data === 'string') return // y-websocket is binary only
    await this.ensureLoaded()
    const buf = new Uint8Array(data)
    const decoder = decoding.createDecoder(buf)
    const messageType = decoding.readVarUint(decoder)
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<SocketAttachment>
    const canEdit = attachment.canEdit === true

    switch (messageType) {
      case MESSAGE_SYNC: {
        const peekDecoder = decoding.clone(decoder)
        const syncSubType = decoding.readVarUint(peekDecoder)
        const isWrite =
          syncSubType === sync.messageYjsSyncStep2 || syncSubType === sync.messageYjsUpdate
        if (isWrite && !canEdit) return // silently drop writes from read-only peers
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        sync.readSyncMessage(decoder, encoder, this.doc!, ws)
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
        return
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness!,
          decoding.readVarUint8Array(decoder),
          ws
        )
        return
      }
      case MESSAGE_QUERY_AWARENESS: {
        const states = this.awareness!.getStates()
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness!, [...states.keys()])
        )
        ws.send(encoding.toUint8Array(encoder))
        return
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleClose(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleClose(ws)
  }

  private async handleClose(ws: WebSocket): Promise<void> {
    await this.ensureLoaded()
    // Drop this user's awareness entries that have no surviving sockets
    // owning the same userId. Best effort — peers also remove their
    // own state on `beforeunload`.
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<SocketAttachment>
    if (this.awareness && attachment.userId) {
      const survivors = this.ctx
        .getWebSockets()
        .filter((s) => s !== ws)
        .map((s) => (s.deserializeAttachment() ?? {}) as Partial<SocketAttachment>)
        .map((a) => a.userId)
      if (!survivors.includes(attachment.userId)) {
        const toDrop: number[] = []
        for (const [clientID, state] of this.awareness.getStates()) {
          const owner = (state as { user?: { id?: string } }).user?.id
          if (owner === attachment.userId) toDrop.push(clientID)
        }
        if (toDrop.length > 0) {
          awarenessProtocol.removeAwarenessStates(this.awareness, toDrop, this)
        }
      }
    }
  }

  // ----- internals --------------------------------------------------------

  /**
   * Lazy load on first message after construct (cold start OR after a
   * hibernation wake). Idempotent + concurrent-safe. After load, sends
   * syncStep1 to every still-attached socket so peers re-send any
   * updates that landed in-memory but weren't yet persisted to R2.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.doc && this.awareness) return
    this.loadPromise ??= this.doLoad()
    await this.loadPromise
  }

  private async doLoad(): Promise<void> {
    if (!this.docId) {
      this.docId = (await this.ctx.storage.get<string>('docId')) ?? null
    }
    const doc = new Y.Doc()
    if (this.docId) {
      const snapshot = await readYjsSnapshot(this.env, this.docId)
      if (snapshot && snapshot.byteLength > 0) {
        Y.applyUpdate(doc, snapshot, LOAD_ORIGIN)
      }
    }
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return
      this.scheduleSnapshotWrite()
      const msg = encodeSyncUpdate(update)
      this.broadcast(msg, origin)
    })
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        const changed = [...added, ...updated, ...removed]
        const msg = encodeAwarenessFrame(awareness, changed)
        this.broadcast(msg, origin)
      }
    )
    this.doc = doc
    this.awareness = awareness

    // Post-eviction resync: ask each still-attached socket for any
    // updates they applied locally but never made it to R2.
    this.broadcast(encodeSyncStep1(doc), undefined)
  }

  private broadcast(msg: Uint8Array, skip: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue
      try {
        ws.send(msg)
      } catch {
        // Socket may be in a closing state.
      }
    }
  }

  private scheduleSnapshotWrite(): void {
    if (!this.doc || !this.docId) return
    this.writePending = Y.encodeStateAsUpdate(this.doc)
    if (this.writeInFlight) return
    this.writeInFlight = this.flushSnapshotQueue()
    // Keep the DO alive until the queue drains. Without this, an
    // idle eviction between webSocketMessage events can drop the
    // R2 write that was kicked off but not awaited inline.
    this.ctx.waitUntil(this.writeInFlight)
  }

  private async flushSnapshotQueue(): Promise<void> {
    try {
      while (this.writePending && this.docId) {
        const bytes = this.writePending
        this.writePending = null
        try {
          await writeYjsSnapshot(this.env, this.docId, bytes)
        } catch (err) {
          console.error('doc-room-do: yjs snapshot write failed', err)
          if (!this.writePending) this.writePending = bytes
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    } finally {
      this.writeInFlight = null
    }
  }
}

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  sync.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  encoding.writeVarUint(encoder, sync.messageYjsUpdate)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

function encodeAwarenessFrame(
  awareness: awarenessProtocol.Awareness,
  clients: number[]
): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(encoder)
}
