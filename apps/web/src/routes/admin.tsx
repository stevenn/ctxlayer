// Stub pages for admin routes. Real implementations land in M5
// (upstreams CRUD, users, teams/products, sandboxes view, usage,
// audit log). Routes mounted so admin nav links don't dead-end.

const ComingInM5 = ({ title }: { title: string }) => (
  <div>
    <h2 style={{ marginTop: 0 }}>{title}</h2>
    <p style={{ color: 'var(--muted)' }}>Admin surfaces arrive in M5.</p>
  </div>
)

export const AdminUpstreams = () => <ComingInM5 title="Admin · Upstreams" />
export const AdminUsers = () => <ComingInM5 title="Admin · Users" />
export const AdminTeams = () => <ComingInM5 title="Admin · Teams" />
export const AdminProducts = () => <ComingInM5 title="Admin · Products" />
export const AdminUsage = () => <ComingInM5 title="Admin · Usage" />
export const AdminAudit = () => <ComingInM5 title="Admin · Audit log" />
