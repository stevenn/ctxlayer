import { defineConfig } from 'tsup'

/**
 * Build the `ctxlayer` CLI to a single CJS bundle.
 *
 * `noExternal` is the load-bearing line: `@ctxlayer/shared` ships as raw TS
 * source — its package `exports` map points at `./src/index.ts` (no build
 * step) and uses extensionless relative imports (`./slug`). Bun and Vite
 * resolve those in dev, but a plain `node dist/cli.cjs` run hits Node's ESM
 * resolver, which can't (`ERR_MODULE_NOT_FOUND: …/shared/src/slug`). Forcing
 * the workspace package to be BUNDLED makes esbuild compile its TS and resolve
 * the extensions, so the emitted CJS is self-contained. Third-party deps
 * (zod, commander, picocolors, …) stay external and resolve from node_modules
 * at runtime.
 */
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  target: 'node20',
  clean: true,
  shims: true,
  noExternal: ['@ctxlayer/shared']
})
