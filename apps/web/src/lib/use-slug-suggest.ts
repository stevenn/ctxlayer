import { useEffect, useState } from 'react'
import { suggestSlug, type SlugEntity } from '@ctxlayer/shared'

/**
 * Live, editable slug suggestion for a create form. The slug auto-fills
 * from `name` as `<prefix>-<slugified-name>` until the user edits the slug
 * field; after that it's left alone (the git-source modal's original
 * pattern, generalised so every create form behaves the same).
 *
 * `reset()` clears the field and re-arms auto-fill — call it when the
 * modal (re)opens.
 */
export function useSlugSuggest(entity: SlugEntity, name: string) {
  const [slug, setSlugRaw] = useState('')
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!touched) setSlugRaw(name.trim() ? suggestSlug(entity, name) : '')
  }, [entity, name, touched])

  return {
    slug,
    touched,
    /** Wire to the slug input's onChange — marks the field user-owned. */
    setSlug: (value: string) => {
      setTouched(true)
      setSlugRaw(value)
    },
    /** Clear + re-arm auto-fill (call on modal open). */
    reset: () => {
      setTouched(false)
      setSlugRaw('')
    }
  }
}
