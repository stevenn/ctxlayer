import { exec } from 'node:child_process'

/**
 * Best-effort browser opener. Branches on process.platform. Never
 * fails the command — prints the URL for manual opening if the
 * platform helper isn't available (e.g. headless Linux without
 * xdg-open).
 */
export function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) {
      console.error(`Could not auto-open the browser. Open this URL manually:\n  ${url}`)
    }
  })
}
