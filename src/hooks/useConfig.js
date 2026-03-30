import { useState, useEffect } from 'react'
import { parseConfig } from '../lib/config.js'

/**
 * Fetch and parse irr_config.yaml, returning a normalized config object.
 *
 * Phase 1: fetchFn defaults to a local fetch from public/irr_config.yaml.
 * Phase 2: pass an authenticated GitHub API fetch function — this is the seam.
 *
 * @param {function} [fetchFn] - Async function that returns YAML text.
 *   Defaults to: () => fetch('/irr_config.yaml').then(r => r.text())
 * @returns {{ config: object|null, loading: boolean, error: string|null }}
 */
export function useConfig(fetchFn) {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        const fn = fetchFn ?? (() => fetch('/irr_config.yaml').then(r => {
          if (!r.ok) throw new Error(`Failed to load config: ${r.status}`)
          return r.text()
        }))
        const text = await fn()
        const parsed = parseConfig(text)
        setConfig(parsed)
      } catch (e) {
        console.error('[useConfig] Error loading config:', e)
        setError(e.message || 'Failed to load configuration.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, []) // intentionally no fetchFn in deps — config loads once on mount

  return { config, loading, error }
}
