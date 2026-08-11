import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePagedLoad } from './use-paged-load'

const page = (items: number[], next: number | null) => ({ items, next })

describe('usePagedLoad', () => {
  it('loads page one, appends on loadMore, and stops at the end', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 2))
      .mockResolvedValueOnce(page([3], null))
    const { result } = renderHook(() => usePagedLoad(fetchPage, [], { pageSize: 2 }))

    await waitFor(() => expect(result.current.status.kind).toBe('ready'))
    expect(result.current.status).toMatchObject({ items: [1, 2], next: 2, loadingMore: false })

    await act(() => result.current.loadMore())
    expect(result.current.status).toMatchObject({ items: [1, 2, 3], next: null })

    // At the end: loadMore is a no-op.
    await act(() => result.current.loadMore())
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('surfaces a load failure as the error state', async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error('kaput'))
    const { result } = renderHook(() =>
      usePagedLoad(fetchPage, [], { pageSize: 10, explain: () => 'It broke.' })
    )
    await waitFor(() => expect(result.current.status.kind).toBe('error'))
    expect(result.current.status).toMatchObject({ message: 'It broke.' })
  })

  it('drops a stale loadMore page when a reload lands first', async () => {
    let releaseMore: (v: { items: number[]; next: number | null }) => void = () => {}
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1], 2))
      // The hanging loadMore fetch:
      .mockImplementationOnce(
        (_opts, signal: AbortSignal | undefined) =>
          new Promise((resolve, reject) => {
            releaseMore = resolve
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
      .mockResolvedValueOnce(page([9], null))
    const { result } = renderHook(() => usePagedLoad(fetchPage, [], { pageSize: 1 }))
    await waitFor(() => expect(result.current.status.kind).toBe('ready'))

    // Start a loadMore that never resolves, then reload underneath it.
    let more: Promise<void> = Promise.resolve()
    act(() => {
      more = result.current.loadMore()
    })
    await act(() => result.current.reload())
    releaseMore(page([2], null))
    await more

    await waitFor(() =>
      expect(result.current.status).toMatchObject({ kind: 'ready', items: [9], next: null })
    )
  })

  it('refetches when deps change', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([1], null))
      .mockResolvedValueOnce(page([2], null))
    const { result, rerender } = renderHook(({ q }) => usePagedLoad(fetchPage, [q], { pageSize: 5 }), {
      initialProps: { q: 'a' }
    })
    await waitFor(() => expect(result.current.status).toMatchObject({ items: [1] }))
    rerender({ q: 'b' })
    await waitFor(() => expect(result.current.status).toMatchObject({ items: [2] }))
  })
})
