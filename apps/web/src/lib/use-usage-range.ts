import { useLocalStorage } from '@mantine/hooks'
import { UsageRange } from '@ctxlayer/shared'

const DEFAULT_RANGE: UsageRange = '30d'

/**
 * Time-window selection for the usage dashboards, persisted to
 * localStorage so the choice sticks across navigations (and reloads).
 * Each page passes its own `scope` so the personal and admin dashboards
 * remember independently.
 *
 * Mirrors the theme-toggle's reliance on Mantine's localStorage backing.
 * `getInitialValueInEffect: false` reads synchronously on mount (this is a
 * client-only SPA, no SSR) so the first fetch already uses the stored range
 * instead of flashing the default and refetching.
 */
export function useUsageRange(scope: 'personal' | 'admin') {
  return useLocalStorage<UsageRange>({
    key: `ctx-usage-range:${scope}`,
    defaultValue: DEFAULT_RANGE,
    getInitialValueInEffect: false,
    // Guard against a stale/invalid stored value from an older build.
    deserialize: (raw) => {
      if (raw === undefined) return DEFAULT_RANGE
      const parsed = UsageRange.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : DEFAULT_RANGE
    }
  })
}
