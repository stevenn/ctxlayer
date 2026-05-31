import { Stack, Text, Title } from '@mantine/core'
import { SearchPanel } from '../components/search/doc-search'

/**
 * The app home: search front-and-center over the whole doc library
 * (authored + git-synced). The browseable library lives at /app/docs.
 */
export function SearchHome() {
  return (
    <Stack gap="lg" maw={820} mx="auto" w="100%" pt="lg">
      <div style={{ textAlign: 'center' }}>
        <Title order={1} fz={28} fw={650}>
          Search
        </Title>
        <Text c="dimmed" fz="sm" mt={6}>
          Ask in plain language — results link straight to the relevant section.
        </Text>
      </div>
      <SearchPanel />
    </Stack>
  )
}
