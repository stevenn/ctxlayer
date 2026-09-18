import { useCallback, useMemo, useRef, useState } from 'react'

/**
 * Client-side column sorting for the `.data-table` screens.
 *
 * The admin lists load their rows in one shot, so sorting stays in the
 * browser: no REST churn, and a sort survives whatever filtering the
 * screen already does (pass the FILTERED array in, not the raw one).
 *
 * Pair with `<SortTh>` (components/admin-bits.tsx) for the header cell —
 * it renders the arrow and wires the aria-sort/click plumbing.
 */

export type SortDir = 'asc' | 'desc'

/** What a column sorts on. Nullish sinks to the bottom in BOTH directions. */
export type SortValue = string | number | boolean | null | undefined

export interface TableSort<K extends string> {
  /** Column currently sorted on. */
  key: K
  dir: SortDir
  /** Header click: same column flips direction, a new column selects it. */
  toggle: (key: K) => void
}

interface TableSortOptions<K extends string> {
  /** Column sorted on first render. */
  key: K
  /** Direction on first render. Defaults to that column's first-click one. */
  dir?: SortDir
  /**
   * Columns whose FIRST click sorts descending — timestamps and counts,
   * where "most recent" / "most" is the interesting end.
   */
  descFirst?: readonly K[]
}

/**
 * `C` (not a bare key union) so the column keys are inferred from the
 * getters map: options.key then type-checks AGAINST that map instead of
 * narrowing it, which is what makes an unknown column name an error.
 */
export function useTableSort<T, C extends Record<string, (row: T) => SortValue>>(
  rows: readonly T[] | null,
  columns: C,
  options: TableSortOptions<Extract<keyof C, string>>
): TableSort<Extract<keyof C, string>> & { sorted: T[] | null } {
  type K = Extract<keyof C, string>

  // Latest getters/options without forcing callers to memoise the literals
  // they pass inline (same trick as useLoad).
  // Typed as a Record over the literal keys so indexing it stays total
  // (C's `Record<string, …>` constraint would make every lookup optional).
  const columnsRef = useRef<Record<K, (row: T) => SortValue>>(columns)
  columnsRef.current = columns
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [state, setState] = useState<{ key: K; dir: SortDir }>(() => ({
    key: options.key,
    dir: options.dir ?? firstDir(options.key, options.descFirst)
  }))

  const toggle = useCallback((key: K) => {
    setState((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: firstDir(key, optionsRef.current.descFirst) }
    )
  }, [])

  const sorted = useMemo(() => {
    if (!rows) return null
    const value = columnsRef.current[state.key]
    const sign = state.dir === 'asc' ? 1 : -1
    // Array#sort is stable, so equal rows keep the incoming order.
    return [...rows].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1
      return sign * compare(av, bv)
    })
  }, [rows, state.key, state.dir])

  return { key: state.key, dir: state.dir, toggle, sorted }
}

function firstDir<K extends string>(key: K, descFirst: readonly K[] | undefined): SortDir {
  return descFirst?.includes(key) ? 'desc' : 'asc'
}

function compare(a: string | number | boolean, b: string | number | boolean): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}
