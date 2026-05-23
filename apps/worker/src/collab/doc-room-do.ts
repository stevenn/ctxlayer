import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

/**
 * One Durable Object per document. M3 wires Yjs awareness/sync over the
 * WebSocket Hibernation API. Snapshot persistence to R2 + revision rows in
 * D1 + reindex queue happen here. Stubbed for the skeleton.
 */
export class DocRoomDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    return new Response('DocRoomDO not yet implemented', { status: 501 })
  }
}
