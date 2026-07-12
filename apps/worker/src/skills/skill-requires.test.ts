import { describe, expect, it } from 'vitest'
import { draftedForUpstreams, missingUpstreams, requiredUpstreamSlugs } from './skill-requires'

describe('skill-requires', () => {
  describe('draftedForUpstreams', () => {
    it('reads the upstreams array from drafter_meta JSON', () => {
      const json = JSON.stringify({ from: 'mcp+agent', upstreams: ['up-ado', 'up-driver'] })
      expect(draftedForUpstreams(json)).toEqual(['up-ado', 'up-driver'])
    })

    it('returns [] for null / malformed / missing', () => {
      expect(draftedForUpstreams(null)).toEqual([])
      expect(draftedForUpstreams('not json')).toEqual([])
      expect(draftedForUpstreams(JSON.stringify({ from: 'manual' }))).toEqual([])
    })

    it('drops non-string entries', () => {
      const json = JSON.stringify({ upstreams: ['up-ado', 3, null, 'up-driver'] })
      expect(draftedForUpstreams(json)).toEqual(['up-ado', 'up-driver'])
    })
  })

  describe('requiredUpstreamSlugs', () => {
    it('unions attachments + drafted-against, deduped', () => {
      expect(requiredUpstreamSlugs(['up-ado'], ['up-ado', 'up-driver'])).toEqual(['up-ado', 'up-driver'])
    })

    it('is empty when neither source has slugs', () => {
      expect(requiredUpstreamSlugs([], [])).toEqual([])
    })
  })

  describe('missingUpstreams', () => {
    it('returns required slugs the caller cannot reach', () => {
      expect(missingUpstreams(['up-ado', 'up-driver'], new Set(['up-driver']))).toEqual(['up-ado'])
    })

    it('is empty when the caller reaches all', () => {
      expect(missingUpstreams(['up-ado'], new Set(['up-ado', 'up-driver']))).toEqual([])
    })
  })
})
