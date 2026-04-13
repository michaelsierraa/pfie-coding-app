import { useState, useEffect, useCallback, useRef } from 'react'
import { parseCSV, getColumnOrder, serializeCSV, downloadCSV } from '../lib/csv.js'
import { saveDraft, loadDraft, markSubmitted } from '../lib/storage.js'

const WORKER_URL = import.meta.env.VITE_WORKER_URL

const PENDING = 'PENDING'

// All 10 standard fields that must be answered before a row is complete
export const REQUIRED_FIELDS = [
  'Status2', 'agencytype', 'agencyname', 'type_new',
  'notactiveswornlocalstate', 'rank', 'offduty', 'training', 'blueonblue',
  'ToRemove',
]

// type_new primaries that require a second-level selection
const TYPE_NEW_NEEDS_SECONDARY = new Set(['Self-inflicted', 'Blue-on-blue'])

export function isRowComplete(row) {
  return REQUIRED_FIELDS.every(field => {
    const v = row[field]
    if (!v || v === PENDING) return false
    if (field === 'type_new') {
      const sep = v.indexOf('; ')
      const primary = sep === -1 ? v : v.slice(0, sep)
      const secondary = sep === -1 ? '' : v.slice(sep + 2)
      if (TYPE_NEW_NEEDS_SECONDARY.has(primary) && !secondary) return false
    }
    return true
  })
}

// Fields that flag for PI when set to '1'
export const PI_REVIEW_TRIGGERS = ['record_added', 'incident_id_changed']

// Fields that flag for PI when set to 'Unknown'
export const UNKNOWN_REVIEW_FIELDS = [
  'Status2', 'agencytype', 'agencyname', 'type_new',
  'notactiveswornlocalstate', 'offduty', 'training', 'blueonblue',
]

/**
 * Returns true if a row should appear in the PI review queue.
 */
export function isRowFlaggedForPI(row) {
  if (PI_REVIEW_TRIGGERS.some(field => row[field] === '1')) return true
  if (UNKNOWN_REVIEW_FIELDS.some(field => row[field] === 'Unknown')) return true
  return false
}

/**
 * Loads a sample CSV, merges any saved draft, and exposes row state +
 * save/submit/add-missing-case actions.
 *
 * Phase 1: fetches from a local URL (public/mock_data/).
 * Phase 2: swap fileUrl for a GitHub Contents API fetch.
 */
export function useSampleData(fileUrl, filename, coderName, sampleId, config, token = null, role = null, isPI = false) {
  const [rows, setRows] = useState([])
  const [columnOrder, setColumnOrder] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastSaved, setLastSaved] = useState(null)

  // Source row count — excludes record_added rows, used for deletion guard
  const originalRowCountRef = useRef(0)

  useEffect(() => {
    if (!fileUrl || !coderName || sampleId == null || !config) return

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const sampleUrl = token
          ? `${WORKER_URL}/sample${sampleId && role ? `?sampleId=${sampleId}&role=${role}` : ''}`
          : fileUrl
        const res = token
          ? await fetch(sampleUrl, { headers: { Authorization: `Bearer ${token}` } })
          : await fetch(fileUrl)
        if (!res.ok) throw new Error(`Failed to load sample CSV: ${res.status}`)
        const text = await res.text()

        const order = getColumnOrder(text)
        setColumnOrder(order)

        const sourceRows = parseCSV(text)
        originalRowCountRef.current = sourceRows.length

        // Multiple rows per IncidentID are expected (multiple officers per incident).

        // ── Initialize coded fields as PENDING ────────────────────────────
        const codedFieldNames = new Set([
          ...config.keyColumns.map(c => c.name),
          ...config.supplementaryColumns.map(c => c.name),
          'CaseSummary',
          'Notes',
          'record_added',  // system field coders can set via Add Case
        ])

        const initialRows = sourceRows.map(row => {
          const initialized = { ...row }
          for (const field of codedFieldNames) {
            if (field in initialized) {
              if (initialized[field] === 'NA' || initialized[field] === '' || initialized[field] == null) {
                initialized[field] = PENDING
              }
            }
          }
          // record_added is system-managed: source rows default to '0'
          if (!initialized.record_added || initialized.record_added === 'NA' || initialized.record_added === PENDING) {
            initialized.record_added = '0'
          }
          return initialized
        })

        // ── Merge saved draft ─────────────────────────────────────────────
        // Match by array index — IncidentID is NOT unique (multi-officer incidents).
        // Only coded (project-added) fields are merged from the draft; source GVA
        // fields (IncidentID, Date, State, Name, etc.) always come from the current
        // source file so a stale draft can never corrupt row identity.
        const draft = loadDraft(coderName, sampleId)
        const finalRows = draft ? mergeDraftByIndex(initialRows, draft, codedFieldNames) : initialRows

        setRows(finalRows)
      } catch (e) {
        console.error('[useSampleData] Load error:', e)
        setError(e.message || 'Failed to load sample data.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [fileUrl, coderName, sampleId, config])

  /**
   * Merge draft rows into source rows by array index.
   * Only coded (project-added) fields are taken from the draft — source GVA fields
   * (IncidentID, Date, State, City, Name, etc.) are always preserved from the
   * current source file.  Extra draft rows (record_added = '1') are appended.
   *
   * @param {object[]} sourceRows   - Rows loaded from the current source CSV
   * @param {object[]} draftRows    - Rows loaded from localStorage
   * @param {Set<string>} codedFields - Field names that may be overwritten
   */
  function mergeDraftByIndex(sourceRows, draftRows, codedFields) {
    const merged = sourceRows.map((sourceRow, i) => {
      const draftRow = draftRows[i]
      if (!draftRow) return sourceRow
      const result = { ...sourceRow }
      for (const field of codedFields) {
        if (field in draftRow) result[field] = draftRow[field]
      }
      return result
    })
    // Append any extra rows from the draft (record_added rows added by the coder)
    if (draftRows.length > sourceRows.length) {
      merged.push(...draftRows.slice(sourceRows.length))
    }
    return merged
  }

  /**
   * Save current row state as a draft to localStorage.
   */
  const saveProgress = useCallback(() => {
    if (!coderName || sampleId == null) return
    saveDraft(coderName, sampleId, rows)
    setLastSaved(new Date())
  }, [coderName, sampleId, rows])

  /**
   * Add a new "missing case" row flagged with record_added=1.
   * The coder provides the IncidentID and a description; all other fields are blank.
   * The PI completes the row during review.
   *
   * @param {string} incidentId - IncidentID the missing officer belongs to
   * @param {string} description - Coder's notes on what's missing
   */
  const addMissingCase = useCallback((incidentId, description) => {
    setRows(prev => {
      // Build a blank row using the first existing row as a template for column names
      const template = prev[0] ?? {}
      const newRow = Object.fromEntries(
        Object.keys(template).map(key => [key, 'NA'])
      )

      // Set known fields
      newRow[config.idColumn] = incidentId
      newRow.record_added = '1'
      newRow.Notes = description
        ? `MISSING CASE — ${description}`
        : 'MISSING CASE — flagged for PI to add'

      // All coded fields start as PENDING so the coder (or PI) can fill them
      const codedFieldNames = new Set([
        ...config.keyColumns.map(c => c.name),
        ...config.supplementaryColumns.map(c => c.name),
        'CaseSummary',
      ])
      for (const field of codedFieldNames) {
        if (field in newRow) newRow[field] = PENDING
      }

      return [...prev, newRow]
    })
  }, [config])

  /**
   * Serialize and download the coded CSV.
   * Maps PENDING → 'NA' for unfilled fields.
   * Returns a rowCountWarning string if rows were deleted, null otherwise.
   */
  const submitCoding = useCallback(() => {
    if (!coderName || sampleId == null || columnOrder.length === 0) return null

    // ── Row count integrity check ────────────────────────────────────────
    // Non-added rows must equal the original source count (no deletions allowed).
    const nonAddedRows = rows.filter(r => r.record_added !== '1')
    const deletedCount = originalRowCountRef.current - nonAddedRows.length
    if (deletedCount > 0) {
      // Return the warning — caller decides whether to block or warn
      const warning = `${deletedCount} row${deletedCount !== 1 ? 's were' : ' was'} deleted from the source sample. This should not happen. Contact the PI before submitting.`
      return { warning }
    }

    // Replace PENDING with 'NA' for all unfilled fields
    const exportRows = rows.map(row => {
      const exported = { ...row }
      for (const key of Object.keys(exported)) {
        if (exported[key] === PENDING) exported[key] = 'NA'
      }
      return exported
    })

    const csvString = serializeCSV(exportRows, columnOrder)

    if (token) {
      // PI finalizing from coder-view writes to pi_reviewed_dir (never irr_coded_samples).
      // Coders write to coded_samples_dir (the default 'coder' destination).
      const body = isPI
        ? { content: csvString, destination: 'pi_full', sampleId, role }
        : { content: csvString }

      return fetch(`${WORKER_URL}/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
        .then(r => r.json())
        .then(data => {
          if (data.error) throw new Error(data.error)
          markSubmitted(coderName, sampleId)
          return null
        })
        .catch(e => ({ warning: `Submission failed: ${e.message}` }))
    }

    // Phase 1 fallback: download CSV locally
    downloadCSV(filename, csvString)
    markSubmitted(coderName, sampleId)
    return null
  }, [rows, columnOrder, filename, coderName, sampleId, token, isPI, role])

  return {
    rows,
    setRows,
    columnOrder,
    loading,
    error,
    saveProgress,
    submitCoding,
    addMissingCase,
    lastSaved,
    originalRowCount: originalRowCountRef.current,
  }
}
