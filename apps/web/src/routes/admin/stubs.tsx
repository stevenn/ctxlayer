// Stubs for admin pages that haven't been implemented yet. Routes
// mounted so admin nav links don't dead-end. Replace as M5 lands.
import { Text, Title } from '@mantine/core'

function ComingSoon({ title, in: where }: { title: string; in: string }) {
  return (
    <div>
      <Title order={2} fz={20} fw={600} mb={4}>
        {title}
      </Title>
      <Text c="dimmed">Arrives in {where}.</Text>
    </div>
  )
}

export const AdminUpstreams = () => <ComingSoon title="Admin · Upstreams" in="M4" />
export const AdminUsers = () => <ComingSoon title="Admin · Users" in="M5" />
export const AdminUsage = () => <ComingSoon title="Admin · Usage" in="M6" />
export const AdminAudit = () => <ComingSoon title="Admin · Audit log" in="M5" />
