// Ensure apps/web/dist/index.html exists so `wrangler dev` and
// `wrangler deploy` don't fail before the SPA has been built. Runs as a
// `predev` / `prebuild` hook in apps/worker/package.json. The real Vite
// build overwrites this file (and emits the JS/CSS bundles next to it).

import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, 'apps/web/dist')
const file = resolve(dir, 'index.html')

mkdirSync(dir, { recursive: true })

if (!existsSync(file)) {
  writeFileSync(
    file,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ctxlayer</title>
  </head>
  <body>
    <p>Placeholder. Run <code>bun run build:web</code> to ship the SPA.</p>
  </body>
</html>
`
  )
  console.log(`ensure-dist: wrote placeholder ${file}`)
}
