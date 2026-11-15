import { activeUsersTool } from './admin'
import { getDoc, searchDocsTool } from './docs'
import { listMyContext, whoami } from './identity'
import { draftSkill, saveDraftSkillTool } from './skill-drafting'
import { getSkill, listSkills } from './skills'
import { listTasks, pollTask } from './tasks'
import type { BuiltinTool } from './types'
import { describeUpstream, listUpstreams } from './upstreams'

/**
 * Every built-in both lanes serve, in the order the agent sees them in
 * `tools/list`. `reload_upstreams` is deliberately absent: what "reload"
 * means depends on the lane (the session lane refreshes its live registry;
 * the stateless lane has nothing cached to refresh), so each lane defines its
 * own and inserts it at `RELOAD_UPSTREAMS_POSITION`.
 */
export const SHARED_BUILTINS: readonly BuiltinTool[] = [
  whoami,
  listMyContext,
  listUpstreams,
  describeUpstream,
  getDoc,
  searchDocsTool,
  activeUsersTool,
  pollTask,
  listTasks,
  listSkills,
  getSkill,
  draftSkill,
  saveDraftSkillTool
]

/** Index in `SHARED_BUILTINS` before which a lane registers `reload_upstreams`. */
export const RELOAD_UPSTREAMS_POSITION = 4

export type { BuiltinCall, BuiltinResult, BuiltinTool } from './types'
