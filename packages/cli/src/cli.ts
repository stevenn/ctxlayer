#!/usr/bin/env node
/**
 * @ctxlayer/cli entry. Commander dispatches to per-command modules
 * under ./commands/. All commands run in the main process; loopback
 * OAuth uses a short-lived child http.Server.
 */

import { Command } from 'commander'
import pc from 'picocolors'
import { loginCommand } from './commands/login'
import { pullCommand } from './commands/pull'
import { whoamiCommand } from './commands/whoami'
import { logoutCommand } from './commands/logout'
import { CtxlayerError, isDebug } from './errors'

const program = new Command()
  .name('ctxlayer')
  .description('ctxlayer CLI — pull org skills into Claude Code')
  .version('0.1.0')

program
  .command('login')
  .description('Sign in to a ctxlayer install via OAuth (DCR + loopback PKCE).')
  .option(
    '--base-url <url>',
    'ctxlayer install URL (e.g. https://ctxlayer.acme.workers.dev). ' +
      'Persisted to credentials.json after first login.'
  )
  .option('--force', 'Re-authenticate even if already logged in.')
  .action(async (opts) => {
    await loginCommand({ baseUrl: opts.baseUrl, force: opts.force })
  })

program
  .command('pull')
  .description(
    'Materialise published skills as SKILL.md files under ~/.claude/skills/ctxlayer/.'
  )
  .option('--dry-run', 'Print what would be written without touching the filesystem.')
  .action(async (opts) => {
    await pullCommand({ dryRun: opts.dryRun })
  })

program
  .command('whoami')
  .description('Print current session info (base URL, client, token expiry).')
  .action(async () => {
    await whoamiCommand()
  })

program
  .command('logout')
  .description('Remove the local credentials file.')
  .action(async () => {
    await logoutCommand()
  })

async function main() {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    if (err instanceof CtxlayerError) {
      console.error(pc.red('error:'), err.message)
      if (isDebug() && err.stack) console.error(err.stack)
      process.exit(1)
    }
    if (err instanceof Error) {
      console.error(pc.red('error:'), err.message)
      if (isDebug() && err.stack) console.error(err.stack)
      process.exit(2)
    }
    console.error(pc.red('error:'), String(err))
    process.exit(2)
  }
}

void main()
