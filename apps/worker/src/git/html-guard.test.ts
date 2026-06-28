import { describe, it, expect } from 'vitest'
import { htmlRoundtripUnsafe } from './html-guard'

describe('htmlRoundtripUnsafe — flags HTML the round-trip drops', () => {
  it('flags HTML comments, anchors, <details>, and styling tags', () => {
    expect(htmlRoundtripUnsafe('before\n<!-- toc -->\nafter')).toBe(true)
    expect(htmlRoundtripUnsafe('<a id="install"></a>\n## Install')).toBe(true)
    expect(htmlRoundtripUnsafe('<details>\n<summary>More</summary>\nx\n</details>')).toBe(true)
    expect(htmlRoundtripUnsafe('Press <kbd>Ctrl</kbd>+C')).toBe(true)
    expect(htmlRoundtripUnsafe('H<sub>2</sub>O')).toBe(true)
    expect(htmlRoundtripUnsafe('<div align="center">\n\nx\n\n</div>')).toBe(true)
  })

  it('does NOT flag plain markdown or the cleanly-converted tags', () => {
    expect(htmlRoundtripUnsafe('# Title\n\nA **bold** paragraph with a [link](/x).')).toBe(false)
    expect(htmlRoundtripUnsafe('line one<br>line two')).toBe(false)
    expect(htmlRoundtripUnsafe('<br/> and <br /> and <img src="a.png" alt="A">')).toBe(false)
  })

  it('does NOT flag angle-bracket autolinks or comparisons', () => {
    expect(htmlRoundtripUnsafe('See <https://example.com> and mail <a@b.com>.')).toBe(false)
    expect(htmlRoundtripUnsafe('if x < 3 and y > 2 then ok')).toBe(false)
  })

  it('ignores HTML inside fenced and inline code (it is a sample, not live)', () => {
    expect(htmlRoundtripUnsafe('```html\n<div class="x"><!-- c --></div>\n```')).toBe(false)
    expect(htmlRoundtripUnsafe('Use the `<details>` element for collapsibles.')).toBe(false)
  })
})
