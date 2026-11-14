/**
 * Client ID Metadata Document (CIMD) clients.
 *
 * With `clientIdMetadataDocumentEnabled` (oauth/provider-config.ts) a client
 * may present an https URL as its client_id; the provider fetches the JSON
 * document at that URL instead of looking a registration up in KV. Nothing
 * about such a client is stored here, which is the point — and the reason a
 * few call sites must treat it differently from a DCR registration.
 */

/**
 * True when `clientId` names a Client ID Metadata Document (an https URL with
 * a path) rather than a client registered in KV. Such a client_id is shared
 * by every installation of that client — and by every user.
 */
export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId)
    return u.protocol === 'https:' && u.pathname !== '/' && u.pathname !== ''
  } catch {
    return false
  }
}
