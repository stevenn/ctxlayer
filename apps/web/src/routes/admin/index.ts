// Barrel for the admin route group. apps/web/src/app.tsx imports
// these named exports — keep names stable when adding new pages.
export { AdminTeams } from './teams'
export { AdminRoles } from './roles'
export { AdminProducts } from './products'
export { AdminUpstreams } from './upstreams'
export { AdminGitSources } from './git-sources'
export { AdminUsers } from './users'
export { AdminInvites } from './invites'
export { AdminJoinCodes } from './join-codes'
export { AdminAudit } from './audit'
export { AdminOAuthClients } from './oauth-clients'
export { AdminUsage } from './usage'
export { AdminSkills } from './skills'
// NOTE: AdminSkillEditor is intentionally NOT re-exported here. It pulls
// in the whole BlockNote/ProseMirror editor stack; app.tsx lazy-imports
// it straight from './skill-editor' so this barrel (and everything that
// statically imports it) stays out of the editor chunk.
