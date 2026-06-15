// Barrel for the REST client, split by domain. Every existing
// `import { … } from '../lib/api'` keeps working unchanged.
// `request` stays internal to this folder (import it from './core').
export { ApiError, ApiSchemaError, fetchConfig, fetchMe, fetchVersion, signOut } from './core'
export * from './docs'
export * from './bundles'
export * from './git'
export * from './skills'
export * from './org'
export * from './admin'
export * from './upstreams'
