import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// This suite runs with vitest globals OFF, so Testing Library's auto-cleanup
// never registers — without this, every render accumulates in the same jsdom
// document and absence assertions (`queryByText(...)` → null) false-fail on
// the previous test's DOM.
afterEach(cleanup)

// jsdom doesn't implement matchMedia; Mantine's color-scheme logic calls it.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
}
