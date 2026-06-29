import { ToolsDirectory } from '@ctxlayer/shared'
import { request } from './core'

// The tools directory feed for /app/tools: built-in tools + every visible
// upstream's tools grouped by family, with per-tool restricted state.
export function fetchTools(signal?: AbortSignal): Promise<ToolsDirectory> {
  return request('/api/tools', (b) => ToolsDirectory.parse(b), { signal })
}
