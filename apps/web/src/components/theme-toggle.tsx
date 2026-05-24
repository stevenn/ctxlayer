import { ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core'

/**
 * Three-state header chip: light → dark → auto → light.
 * Mantine persists the override in localStorage under
 * `mantine-color-scheme-value` and updates `data-mantine-color-scheme`
 * on <html>, which our CSS-var blocks key off.
 */
export function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme()

  const next: Record<typeof colorScheme, typeof colorScheme> = {
    light: 'dark',
    dark: 'auto',
    auto: 'light'
  }
  const label: Record<typeof colorScheme, string> = {
    light: 'Light',
    dark: 'Dark',
    auto: 'Auto'
  }
  const icon: Record<typeof colorScheme, string> = {
    light: '☀',
    dark: '☾',
    auto: '◐'
  }

  return (
    <Tooltip label={`Theme: ${label[colorScheme]} (click to change)`} withArrow>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label={`Theme: ${label[colorScheme]}`}
        onClick={() => setColorScheme(next[colorScheme])}
      >
        <span style={{ fontSize: 16 }}>{icon[colorScheme]}</span>
      </ActionIcon>
    </Tooltip>
  )
}
