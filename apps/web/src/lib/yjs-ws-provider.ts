/**
 * Minimal Yjs WebSocket provider — same wire as y-websocket, talking to
 * our same-origin /collab/:docId endpoint so the session cookie rides
 * along. We don't depend on `y-websocket` because it assumes a `room`
 * query param + opinionated reconnect logic, and we already shard per-
 * doc in the URL.
 *
 * Status flow:
 *   connecting -> connected (socket open; syncStep1 SENT)
 *   any        -> reconnecting (on close; exponential backoff)
 *   destroy()  -> disconnected (terminal; null awareness sent first)
 *
 * NOTE: `connected` means the socket is open and we've sent syncStep1 —
 * NOT that the document content has arrived. The server's syncStep2
 * (the full initial state) lands later, and for a large doc that gap is
 * visible: the editor is mounted but still empty. `onSynced` fires once
 * that first syncStep2 is applied — the real "doc is loaded" signal,
 * which the editor uses to gate its loading overlay.
 *
 * Public surface mirrors what BlockNote / y-prosemirror's cursor
 * plugin expects: `.awareness`, `.doc`, plus `.onStatus` / `.onSynced`.
 */

import type * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

export type CollabStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
export type CollabStatusListener = (status: CollabStatus) => void

export class CollabWSProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  private readonly url: string
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private destroyed = false
  private status: CollabStatus = 'connecting'
  private synced = false
  private readonly listeners = new Set<CollabStatusListener>()
  private readonly syncListeners = new Set<() => void>()
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void
  private readonly handleAwarenessUpdate: (
    diff: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void
  private readonly handleUnload: () => void

  constructor(url: string, doc: Y.Doc) {
    this.url = url
    this.doc = doc
    this.awareness = new Awareness(doc)

    this.handleDocUpdate = (update, origin) => {
      // `origin === this` means the update came from the server; do
      // not echo it back.
      if (origin === this) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      encoding.writeVarUint(encoder, sync.messageYjsUpdate)
      encoding.writeVarUint8Array(encoder, update)
      this.send(encoding.toUint8Array(encoder))
    }
    doc.on('update', this.handleDocUpdate)

    this.handleAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return
      const changed = [...added, ...updated, ...removed]
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed))
      this.send(encoding.toUint8Array(encoder))
    }
    this.awareness.on('update', this.handleAwarenessUpdate)

    // Best-effort: announce we're leaving on tab close so peers don't
    // see a ghost cursor for the awareness timeout window.
    this.handleUnload = () => {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'window-unload')
    }
    window.addEventListener('beforeunload', this.handleUnload)

    this.connect()
  }

  onStatus(cb: CollabStatusListener): () => void {
    this.listeners.add(cb)
    cb(this.status)
    return () => this.listeners.delete(cb)
  }

  /**
   * Fires once the initial server sync (first syncStep2) has been
   * applied to the local doc — i.e. the document content is fully
   * materialized. Distinct from `connected`, which fires on socket open
   * BEFORE the content arrives. Late subscribers are invoked immediately
   * if sync already happened. Latches: a reconnect re-syncs but never
   * flips back to "unsynced", so callers won't re-show a loader.
   */
  onSynced(cb: () => void): () => void {
    if (this.synced) {
      cb()
      return () => {}
    }
    this.syncListeners.add(cb)
    return () => this.syncListeners.delete(cb)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    window.removeEventListener('beforeunload', this.handleUnload)
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    } catch {
      // awareness may be torn down — fine.
    }
    this.doc.off('update', this.handleDocUpdate)
    this.awareness.off('update', this.handleAwarenessUpdate)
    if (this.ws) closeWhenReady(this.ws)
    this.ws = null
    this.setStatus('disconnected')
  }

  // ----- internals --------------------------------------------------------

  private connect(): void {
    if (this.destroyed) return
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      // Send our state vector so the server replies with a syncStep2
      // covering everything it has that we don't.
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      sync.writeSyncStep1(encoder, this.doc)
      ws.send(encoding.toUint8Array(encoder))
      // Also ask for current awareness snapshot.
      const queryEncoder = encoding.createEncoder()
      encoding.writeVarUint(queryEncoder, MESSAGE_QUERY_AWARENESS)
      ws.send(encoding.toUint8Array(queryEncoder))
      // Announce our own awareness if non-empty.
      if (this.awareness.getLocalState()) {
        const announceEncoder = encoding.createEncoder()
        encoding.writeVarUint(announceEncoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          announceEncoder,
          encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
        )
        ws.send(encoding.toUint8Array(announceEncoder))
      }
      this.setStatus('connected')
    }

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      const buf = new Uint8Array(ev.data)
      const decoder = decoding.createDecoder(buf)
      const type = decoding.readVarUint(decoder)
      switch (type) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          const syncType = sync.readSyncMessage(decoder, encoder, this.doc, this)
          if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder))
          // syncStep2 is the server's reply to our syncStep1: it carries
          // the full initial document state. Once applied, the doc is
          // loaded. (Empty docs still receive a syncStep2, so this fires
          // for them too — the loader never hangs on a blank doc.)
          if (syncType === sync.messageYjsSyncStep2) this.markSynced()
          return
        }
        case MESSAGE_AWARENESS:
          applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this)
          return
      }
    }

    ws.onclose = () => {
      this.ws = null
      if (this.destroyed) return
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer != null) return
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS)
    this.reconnectAttempt += 1
    this.setStatus('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private send(bytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes)
    }
    // If not open: discard. Yjs will resync on the next syncStep1
    // after reconnect.
  }

  private markSynced(): void {
    if (this.synced) return
    this.synced = true
    for (const cb of this.syncListeners) {
      try {
        cb()
      } catch {
        // listener errors are not the provider's problem.
      }
    }
    this.syncListeners.clear()
  }

  private setStatus(next: CollabStatus): void {
    if (next === this.status) return
    this.status = next
    for (const cb of this.listeners) {
      try {
        cb(next)
      } catch {
        // listener errors are not the provider's problem.
      }
    }
  }
}

/**
 * Close a WebSocket without the browser logging "WebSocket is closed
 * before the connection is established" — which happens when `close()`
 * runs while readyState is CONNECTING, and is otherwise unavoidable
 * under React StrictMode's synthetic unmount.
 */
function closeWhenReady(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    })
    return
  }
  try {
    ws.close()
  } catch {
    // ignore
  }
}
