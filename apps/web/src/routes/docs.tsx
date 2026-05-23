// Compatibility shim: existing imports from './docs' keep working
// while the implementation lives in docs-list.tsx (list view) and
// docs-editor.tsx (editor route).
export { DocsList as Docs } from './docs-list'
