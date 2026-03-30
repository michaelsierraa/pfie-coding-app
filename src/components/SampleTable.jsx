import { useEffect, useMemo, useRef, useState } from 'react'
import CodingRow from './CodingRow.jsx'
import NewIncidentForm from './NewIncidentForm.jsx'
import IncidentOverview from './IncidentOverview.jsx'
import { isSubmitted } from '../lib/storage.js'
import { isRowFlaggedForPI, UNKNOWN_REVIEW_FIELDS, isRowComplete } from '../hooks/useSampleData.js'

const PENDING = 'PENDING'

const INTEGRITY_FIELDS = [
  'Duplicate', 'duplicate_type', 'duplicate_of',
  'record_added', 'incident_id_changed', 'incident_change_type', 'reassign_to_id', 'original_id',
]

/** Group a flat rows array into incident groups, preserving first-appearance order. */
function groupByIncident(rows, idColumn) {
  const groups = []
  const indexMap = {}
  rows.forEach((row, idx) => {
    const id = row[idColumn] || 'UNKNOWN'
    if (!(id in indexMap)) {
      indexMap[id] = groups.length
      groups.push({ id, indices: [], rows: [] })
    }
    const g = groups[indexMap[id]]
    g.indices.push(idx)
    g.rows.push(row)
  })
  return groups
}

export default function SampleTable({
  coderName,
  session,
  config,
  rows,
  setRows,
  saveProgress,
  submitCoding,
  lastSaved,
  onLogout,
}) {
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [rowCountWarning, setRowCountWarning] = useState(null)
  const [integrityWarning, setIntegrityWarning] = useState(false)
  const [showNewIncidentForm, setShowNewIncidentForm] = useState(false)
  const [currentIncidentIdx, setCurrentIncidentIdx] = useState(0)
  const [showOverview, setShowOverview] = useState(false)
  // Set after adding a new incident so we navigate to it once groups update
  const [pendingNavId, setPendingNavId] = useState(null)

  const alreadySubmitted = isSubmitted(coderName, session.sampleId)

  // Auto-save every 60 seconds
  const saveRef = useRef(saveProgress)
  useEffect(() => { saveRef.current = saveProgress })
  useEffect(() => {
    const interval = setInterval(() => saveRef.current(), 60_000)
    return () => clearInterval(interval)
  }, [])

  // ── Incident groups ───────────────────────────────────────────────────────
  const incidentGroups = useMemo(
    () => groupByIncident(rows, config.idColumn),
    [rows, config.idColumn],
  )
  const totalIncidents = incidentGroups.length

  // Clamp index in case rows were deleted
  const safeIdx = Math.min(currentIncidentIdx, Math.max(0, totalIncidents - 1))
  const currentGroup = incidentGroups[safeIdx] ?? { id: '', indices: [], rows: [] }

  // Navigate to new incident once groups recompute after row add
  useEffect(() => {
    if (!pendingNavId) return
    const idx = incidentGroups.findIndex(g => g.id === pendingNavId)
    if (idx !== -1) {
      setCurrentIncidentIdx(idx)
      setPendingNavId(null)
    }
  }, [pendingNavId, incidentGroups])

  // ── Global progress ───────────────────────────────────────────────────────
  const sourceRows    = rows.filter(r => r.record_added !== '1')
  const addedRows     = rows.filter(r => r.record_added === '1')
  const completedCount = sourceRows.filter(r => isRowComplete(r)).length
  const totalCount    = sourceRows.length
  const allComplete   = completedCount === totalCount && totalCount > 0
  const incompleteCount = totalCount - completedCount

  // ── Per-incident status ───────────────────────────────────────────────────
  const currentSourceRows    = currentGroup.rows.filter(r => r.record_added !== '1')
  const currentCompleteCount = currentSourceRows.filter(r => isRowComplete(r)).length
  const currentIsComplete    = currentSourceRows.length > 0 && currentCompleteCount === currentSourceRows.length
  const currentNeedsExp      = currentGroup.rows.some(row => {
    const hasFlag = INTEGRITY_FIELDS.some(f => {
      const v = row[f]; return v && v !== '0' && v !== 'NA' && v !== PENDING && v !== ''
    })
    const hasNotes = row.CaseSummary && row.CaseSummary !== 'NA' && row.CaseSummary !== PENDING && row.CaseSummary.trim() !== ''
    return hasFlag && !hasNotes
  })
  const currentIsFlagged = currentGroup.rows.some(isRowFlaggedForPI)

  // ── Global integrity check (for banner) ──────────────────────────────────
  const rowsNeedingExplanation = rows.filter(row => {
    const hasFlag = INTEGRITY_FIELDS.some(f => {
      const v = row[f]; return v && v !== '0' && v !== 'NA' && v !== PENDING && v !== ''
    })
    const hasNotes = row.CaseSummary && row.CaseSummary !== 'NA' && row.CaseSummary !== PENDING && row.CaseSummary.trim() !== ''
    return hasFlag && !hasNotes
  })

  // ── PI review queue (global) ──────────────────────────────────────────────
  const piReviewRows = rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => isRowFlaggedForPI(row))

  // ── Navigation ────────────────────────────────────────────────────────────
  function navigateTo(idx) {
    saveProgress()
    setCurrentIncidentIdx(idx)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Row handlers (all receive global indices) ─────────────────────────────
  function handleRowChange(globalIdx, fieldName, value) {
    setRows(prev => {
      const updated = [...prev]
      updated[globalIdx] = { ...updated[globalIdx], [fieldName]: value }
      return updated
    })
  }

  function handleAddCaseUnderIncident(globalIdx) {
    const sourceRow = rows[globalIdx]
    const incidentId = sourceRow[config.idColumn]

    const confirmed = window.confirm(
      `Add a new case under Incident ID ${incidentId}?\n\n` +
      `Source fields (date, location, incident characteristics) will be copied from this row. ` +
      `All coding fields will be blank. ` +
      `This row will be flagged for PI review.`
    )
    if (!confirmed) return

    const newRow = { ...sourceRow }
    newRow.record_added = '1'

    const officerFields = ['Name', 'Type', 'Gender', 'Age', 'Agegroup', 'Status']
    for (const f of officerFields) {
      if (f in newRow) newRow[f] = 'NA'
    }

    const codedFieldNames = [
      ...config.keyColumns.map(c => c.name),
      ...config.supplementaryColumns.map(c => c.name),
      'CaseSummary',
    ]
    for (const field of codedFieldNames) {
      if (field in newRow) newRow[field] = PENDING
    }

    newRow.CaseSummary = `ADDED CASE — additional officer in incident ${incidentId}. Officer details (Name, Gender, Age, Status) to be completed by PI.`
    newRow.Notes = ''

    setRows(prev => [...prev, newRow])
  }

  function handleDeleteCustomCase(globalIdx) {
    if (rows[globalIdx]?.record_added !== '1') return
    const incidentId = rows[globalIdx][config.idColumn]
    const confirmed = window.confirm(
      `Delete the added case for Incident ID ${incidentId}? This cannot be undone.`
    )
    if (!confirmed) return
    setRows(prev => prev.filter((_, i) => i !== globalIdx))
  }

  function handleAddNewIncident(newRow) {
    setRows(prev => [...prev, newRow])
    setShowNewIncidentForm(false)
    setPendingNavId(newRow[config.idColumn])
  }

  function handleNewIncidentClick() {
    const confirmed = window.confirm(
      'Add a completely new incident?\n\n' +
      'Only use this if you found an incident through source research that has NO existing record in the GVA dataset — ' +
      'no Incident ID, no row in the current sample.\n\n' +
      'If the incident already exists in the data, use "Add Case" or "Incorrect Incident ID?" on the relevant row instead.'
    )
    if (confirmed) setShowNewIncidentForm(true)
  }

  function handleSave() {
    if (rowsNeedingExplanation.length > 0) setIntegrityWarning(true)
    saveProgress()
  }

  function handleSubmit() {
    setSubmitAttempted(true)
    if (!allComplete) return
    const result = submitCoding()
    if (result?.warning) {
      setRowCountWarning(result.warning)
      return
    }
    setSubmitAttempted(false)
  }

  // ── Last-saved label ──────────────────────────────────────────────────────
  function formatLastSaved(date) {
    if (!date) return ''
    const s = Math.round((Date.now() - date.getTime()) / 1000)
    if (s < 5) return 'Saved just now'
    if (s < 60) return `Saved ${s}s ago`
    return `Saved ${Math.round(s / 60)}m ago`
  }
  const [saveLabel, setSaveLabel] = useState('')
  useEffect(() => {
    setSaveLabel(formatLastSaved(lastSaved))
    const interval = setInterval(() => setSaveLabel(formatLastSaved(lastSaved)), 5000)
    return () => clearInterval(interval)
  }, [lastSaved])

  // ── Incident status pill ──────────────────────────────────────────────────
  function IncidentStatusPill() {
    if (currentNeedsExp)   return <span className="incident-status-pill warn">⚠ Needs explanation</span>
    if (currentIsFlagged)  return <span className="incident-status-pill flag">PI flagged</span>
    if (currentIsComplete) return <span className="incident-status-pill complete">✓ Complete</span>
    return (
      <span className="incident-status-pill incomplete">
        {currentCompleteCount}/{currentSourceRows.length} complete
      </span>
    )
  }

  // ── Nav bar (reused at top and bottom) ────────────────────────────────────
  function NavBar({ showStatus }) {
    return (
      <div className="incident-nav">
        <button
          className="btn btn-secondary"
          onClick={() => navigateTo(safeIdx - 1)}
          disabled={safeIdx === 0}
        >
          ← Prev
        </button>
        <div className="incident-nav-center">
          <span className="incident-nav-pos">
            {safeIdx + 1} <span className="incident-nav-of">of</span> {totalIncidents}
          </span>
          <span className="incident-nav-id">{currentGroup.id}</span>
          {showStatus && <IncidentStatusPill />}
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => navigateTo(safeIdx + 1)}
          disabled={safeIdx === totalIncidents - 1}
        >
          Next →
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell">

      {/* ── Sticky header ── */}
      <div className="table-header">
        <div>
          <h2>{coderName} — {session.label}</h2>
          {session.partnerName && (
            <div style={{ fontSize: '0.8rem', color: '#666' }}>Partner: {session.partnerName}</div>
          )}
        </div>

        <div className="progress-badge">
          <span>{completedCount}</span> / {totalCount} rows complete
          {addedRows.length > 0 && (
            <span style={{ marginLeft: '0.75rem', color: '#c05621' }}>
              + {addedRows.length} added
            </span>
          )}
        </div>

        {saveLabel && <div className="autosave-indicator">{saveLabel}</div>}

        <div className="table-actions">
          <button className="btn btn-secondary" onClick={() => setShowOverview(true)}>
            Overview
          </button>
          <a
            href="/GVA_Project_Onboarding.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="coding-guide-link"
          >
            Coding Guide ↗
          </a>
          <button className="btn btn-secondary" onClick={handleSave}>Save</button>
          <button className="btn btn-secondary" onClick={onLogout}>Switch Coder</button>
          <button className="btn btn-warning" onClick={handleNewIncidentClick}>
            + New Incident
          </button>
        </div>

        <div className="header-progress-bar">
          <div
            className="header-progress-fill"
            style={{ width: totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%' }}
          />
        </div>
      </div>

      {/* ── Top incident nav ── */}
      <NavBar showStatus />

      {/* ── Alerts ── */}
      {rowCountWarning && (
        <div className="alert alert-error" style={{ margin: '0.75rem 1.25rem 0', display: 'flex', justifyContent: 'space-between' }}>
          <span><strong>Row count error:</strong> {rowCountWarning}</span>
          <button className="btn btn-secondary" onClick={() => setRowCountWarning(null)} style={{ fontSize: '0.8rem', marginLeft: '1rem' }}>Dismiss</button>
        </div>
      )}

      {integrityWarning && rowsNeedingExplanation.length > 0 && (
        <div className="alert alert-warning" style={{ margin: '0.75rem 1.25rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            <strong>{rowsNeedingExplanation.length} row{rowsNeedingExplanation.length !== 1 ? 's have' : ' has'} data integrity flags</strong> without a Case Summary explanation.
          </span>
          <button className="btn btn-secondary" onClick={() => setIntegrityWarning(false)} style={{ fontSize: '0.8rem', marginLeft: '1rem' }}>Dismiss</button>
        </div>
      )}

      {submitAttempted && !allComplete && (
        <div className="alert alert-error" style={{ margin: '0.75rem 1.25rem 0' }}>
          {incompleteCount} row{incompleteCount !== 1 ? 's are' : ' is'} incomplete.
          All 10 standard fields must be answered before submitting.
        </div>
      )}

      {alreadySubmitted && (
        <div className="submitted-banner" style={{ margin: '0.75rem 1.25rem 0' }}>
          <div>
            <h3>Sample submitted</h3>
            <p>You have already submitted {session.filename}. To resubmit with corrections, click Submit again.</p>
          </div>
        </div>
      )}

      {/* ── PI Review Queue (global) ── */}
      {piReviewRows.length > 0 && (
        <div className="pi-review-panel">
          <div className="pi-review-header">
            PI Review Queue — {piReviewRows.length} row{piReviewRows.length !== 1 ? 's' : ''} flagged
          </div>
          <table className="pi-review-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>IncidentID</th>
                <th>Flag</th>
                <th>Case Summary / Notes</th>
              </tr>
            </thead>
            <tbody>
              {piReviewRows.map(({ row, idx }) => {
                const flags = []
                if (row.record_added === '1') flags.push('Added')
                if (row.incident_id_changed === '1') flags.push('ID Changed')
                const unknownCount = UNKNOWN_REVIEW_FIELDS.filter(f => row[f] === 'Unknown').length
                if (unknownCount > 0) flags.push(`Unknown (${unknownCount} field${unknownCount !== 1 ? 's' : ''})`)
                const detail = (row.CaseSummary && row.CaseSummary !== 'NA' && row.CaseSummary !== PENDING)
                  ? row.CaseSummary
                  : '—'
                return (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td><code>{row[config.idColumn]}</code></td>
                    <td>{flags.join(', ')}</td>
                    <td className="pi-review-detail">{detail}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── New Incident form ── */}
      {showNewIncidentForm && (
        <NewIncidentForm
          config={config}
          allRows={rows}
          onSubmit={handleAddNewIncident}
          onCancel={() => setShowNewIncidentForm(false)}
        />
      )}

      {/* ── Coding rows for current incident only ── */}
      <div className="sample-rows">
        {currentGroup.rows.map((row, localIdx) => {
          const globalIdx = currentGroup.indices[localIdx]
          return (
            <CodingRow
              key={globalIdx}
              row={row}
              config={config}
              onChange={(field, value) => handleRowChange(globalIdx, field, value)}
              rowIndex={localIdx + 1}
              dataIndex={globalIdx}
              allRows={rows}
              isAddedRow={row.record_added === '1'}
              onAddCase={() => handleAddCaseUnderIncident(globalIdx)}
              onDeleteCase={() => handleDeleteCustomCase(globalIdx)}
            />
          )
        })}
      </div>

      {/* ── Bottom incident nav ── */}
      <NavBar showStatus={false} />

      {/* ── Submit footer ── */}
      <div className="submit-footer">
        {!allComplete && (
          <span className="incomplete-warning">
            {incompleteCount} row{incompleteCount !== 1 ? 's' : ''} still incomplete
          </span>
        )}
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          style={{ marginLeft: allComplete ? 0 : 'auto' }}
        >
          {alreadySubmitted ? 'Resubmit (Download Updated CSV)' : 'Submit (Download CSV)'}
        </button>
      </div>

      {/* ── Incident Overview drawer ── */}
      {showOverview && (
        <IncidentOverview
          groups={incidentGroups}
          currentIdx={safeIdx}
          onNavigate={navigateTo}
          onClose={() => setShowOverview(false)}
        />
      )}

    </div>
  )
}
