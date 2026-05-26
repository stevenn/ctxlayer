/**
 * Tool-name mangle/unmangle rule lives in `packages/shared/src/tool-name.ts`
 * so the SPA admin tool-browser can compute the same agent-visible name
 * without duplicating the logic. This file is a thin re-export kept for
 * import-path stability.
 */
export {
  collapseSlugPrefix,
  mangleToolName,
  unmangleToolName,
  type UnmangledTool
} from '@ctxlayer/shared'
