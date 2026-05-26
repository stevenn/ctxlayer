import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements
} from 'react-router-dom'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { appRoutes } from './app'
import { appTheme } from './theme'
import { DialogProvider } from './lib/dialogs'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

// Data router (vs <BrowserRouter>) is required so `useBlocker` works
// in the editor — that's how we intercept in-app navigation when a
// doc has unsaved changes. Hard refresh / close-tab is still caught
// by the editor's `beforeunload` listener.
const router = createBrowserRouter(createRoutesFromElements(appRoutes()))

// ColorSchemeScript injects a small inline <script> that sets
// `data-mantine-color-scheme` on <html> before paint, so the page
// doesn't flash light then jump to dark.
createRoot(root).render(
  <StrictMode>
    <ColorSchemeScript defaultColorScheme="auto" />
    <MantineProvider theme={appTheme} defaultColorScheme="auto">
      <DialogProvider>
        <RouterProvider router={router} />
      </DialogProvider>
    </MantineProvider>
  </StrictMode>
)
