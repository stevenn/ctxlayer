import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * Per-OS path resolution. All paths anchored to `os.homedir()` (which
 * resolves to %USERPROFILE% on Windows, $HOME elsewhere) — never use
 * a hardcoded ~ since fs.* doesn't expand it.
 */

/**
 * Where SKILL.md files land. Claude Code reads from here.
 * Same path on every OS — that's intentional, since Claude Code
 * itself resolves $HOME/.claude on all platforms.
 */
export function skillsDir(): string {
  return join(homedir(), '.claude', 'skills', 'ctxlayer')
}

/**
 * Where credentials.json lives. Windows prefers %APPDATA%; mac/linux
 * follow XDG_CONFIG_HOME (defaulting to $HOME/.config).
 */
export function configDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'ctxlayer')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ctxlayer')
}

export function credentialsFile(): string {
  return join(configDir(), 'credentials.json')
}
