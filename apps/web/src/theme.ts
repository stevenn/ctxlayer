import { createTheme, type MantineColorsTuple } from '@mantine/core'

// Tailwind's `blue` ramp (50..900) → Mantine's 0..9 tuple. Picked over
// Mantine's default blue because the project memory specifies a
// "Royal" #2563eb primary (blue-600), and the roadmapper reference
// has a heavier saturated feel we want to mirror.
const blue: MantineColorsTuple = [
  '#eff6ff', // 50  → mantine index 0
  '#dbeafe', // 100 → 1
  '#bfdbfe', // 200 → 2
  '#93c5fd', // 300 → 3
  '#60a5fa', // 400 → 4
  '#3b82f6', // 500 → 5  (dark-mode primary)
  '#2563eb', // 600 → 6  (light-mode primary)
  '#1d4ed8', // 700 → 7
  '#1e40af', // 800 → 8
  '#1e3a8a'  // 900 → 9
]

export const appTheme = createTheme({
  primaryColor: 'blue',
  primaryShade: { light: 6, dark: 5 },
  colors: { blue },
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  defaultRadius: 'sm',
  radius: { xs: '2px', sm: '4px', md: '6px', lg: '8px', xl: '12px' },
  cursorType: 'pointer'
})
