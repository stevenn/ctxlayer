// Pull the `cloudflare:test` module declaration into tsc's scope so
// integration test files + setup typecheck cleanly. The triple-slash
// reference here is enough — vitest itself resolves the module at
// runtime through @cloudflare/vitest-pool-workers.
/// <reference types="@cloudflare/vitest-pool-workers" />
