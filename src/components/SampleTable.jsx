import { useEffect, useMemo, useRef, useState } from 'react'
import CodingRow from './CodingRow.jsx'
import NewIncidentForm from './NewIncidentForm.jsx'
import IncidentOverview from './IncidentOverview.jsx'
import { isSubmitted } from '../lib/storage.js'
import { isRowFlaggedForPI, isRowComplete } from '../hooks/useSampleData.js'

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
  onPIBack,
}) {
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [rowCountWarning, setRowCountWarning] = useState(null)
  const [integrityWarning, setIntegrityWarning] = useState(false)
  const [showNewIncidentForm, setShowNewIncidentForm] = useState(false)
  const [currentIncidentIdx, setCurrentIncidentIdx] = useState(0)
  const [showOverview, setShowOverview] = useState(false)
  const [showFinalizeModal, setShowFinalizeModal] = useState(false)
  const [showBlockedModal, setShowBlockedModal] = useState(false)
  // Set after adding a new incident so we navigate to it once groups update
  const [pendingNavId, setPendingNavId] = useState(null)
  const [history, setHistory] = useState([])

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
  // A row is "done" when fully complete OR flagged for PI review
  const allDone       = totalCount > 0 && sourceRows.every(r => isRowComplete(r) || isRowFlaggedForPI(r))
  const allComplete   = completedCount === totalCount && totalCount > 0
  const incompleteCount = sourceRows.filter(r => !isRowComplete(r) && !isRowFlaggedForPI(r)).length
  const completedIncidentCount = incidentGroups.filter(g => {
    const src = g.rows.filter(r => r.record_added !== '1')
    return src.length > 0 && src.every(r => isRowComplete(r))
  }).length

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

  // ── Navigation ────────────────────────────────────────────────────────────
  function navigateTo(idx) {
    saveProgress()
    setCurrentIncidentIdx(idx)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Undo ──────────────────────────────────────────────────────────────────
  function pushHistory() {
    setHistory(prev => [...prev.slice(-29), rows])
  }

  function handleUndo() {
    if (history.length === 0) return
    const snapshot = history[history.length - 1]
    setHistory(prev => prev.slice(0, -1))
    setRows(snapshot)
  }

  // ── Row handlers (all receive global indices) ─────────────────────────────
  function handleRowChange(globalIdx, fieldName, value) {
    pushHistory()
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

    pushHistory()

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
    pushHistory()
    setRows(prev => prev.filter((_, i) => i !== globalIdx))
  }

  function handleAddNewIncident(newRow) {
    pushHistory()
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
    if (!allDone) return
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
          <span className="incident-nav-id">
            <span style={{ fontSize: '0.72em', fontWeight: 400, color: '#888', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Incident ID</span>
            {' '}{currentGroup.id}
          </span>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{coderName} — {session.label}</h2>
            {session.partnerName && (
              <div style={{ fontSize: '0.8rem', color: '#666' }}>Partner: {session.partnerName}</div>
            )}
          </div>
          {onPIBack && (
            <button
              className="btn btn-secondary"
              onClick={onPIBack}
              style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
            >
              ← Back to coder list
            </button>
          )}
        </div>

        <div style={{ textAlign: 'center' }}>
          <span className="progress-badge">
            <span>{completedCount}</span> / {totalCount} rows complete
            {addedRows.length > 0 && (
              <span style={{ marginLeft: '0.75rem', color: '#c05621' }}>
                + {addedRows.length} added
              </span>
            )}
            <span style={{ margin: '0 0.75rem', opacity: 0.4 }}>·</span>
            <span>{completedIncidentCount}</span> / {totalIncidents} incidents complete
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setShowOverview(true)}
            style={{ border: '2px solid #3b82f6' }}
          >
            <i className="bi bi-list-check" style={{ marginRight: '0.35rem' }} />
            Status Tracker
          </button>
          {saveLabel && <div className="autosave-indicator">{saveLabel}</div>}
        </div>

        <div className="table-actions">

          <button
            className="btn btn-secondary"
            onClick={handleUndo}
            disabled={history.length === 0}
            title="Undo last change"
          >
            ↩ Undo
          </button>
          {!onPIBack && (
            <button className="btn btn-secondary" onClick={onLogout}>Switch Coder</button>
          )}
          <button className="btn btn-warning" onClick={handleNewIncidentClick} style={{ marginLeft: 'auto' }}>
            + New Incident
          </button>
          <button
            className="btn"
            onClick={() => allDone ? setShowFinalizeModal(true) : setShowBlockedModal(true)}
            style={{
              backgroundColor: allDone ? '#b8860b' : '#ccc',
              color: allDone ? '#fff' : '#888',
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: allDone ? 'pointer' : 'not-allowed',
            }}
          >
            <i className="bi bi-lock-fill" />
            FINALIZE
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

      {submitAttempted && !allDone && (
        <div className="alert alert-error" style={{ margin: '0.75rem 1.25rem 0' }}>
          {incompleteCount} row{incompleteCount !== 1 ? 's are' : ' is'} not yet complete or PI flagged.
          All rows must be complete or flagged for PI review before submitting.
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
              onSave={handleSave}
            />
          )
        })}
      </div>

      {/* ── Bottom incident nav ── */}
      <NavBar showStatus={false} />


      {/* ── Finalize blocked modal ── */}
      {showBlockedModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '8px', padding: '2rem', maxWidth: '420px', width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Cannot Finalize</h3>
            <p style={{ lineHeight: 1.6, marginBottom: '1.25rem' }}>
              Data cannot be finalized and submitted until all case coding is completed.
            </p>
            <p style={{ lineHeight: 1.6, marginBottom: '1.75rem' }}>
              Click <strong style={{ color: '#3b82f6' }}>Status Tracker</strong> to see coding status of all cases. Resolve{' '}
              <i className="bi bi-file-x-fill" style={{ color: '#e53e3e', fontSize: '1rem', verticalAlign: 'middle' }} />{' '}
              cases to enable FINALIZE.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setShowBlockedModal(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Finalize confirmation modal ── */}
      {showFinalizeModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '8px', padding: '2rem', maxWidth: '480px', width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Finalize &amp; Submit</h3>
            <p style={{ marginBottom: '1.5rem', lineHeight: 1.6 }}>
              This will finalize all data you have input and submit for PI review.{' '}
              <strong>You will not be able to edit your coding if you proceed.</strong>
            </p>
            <p style={{ marginBottom: '1.75rem', lineHeight: 1.6 }}>
              If you have not reviewed your data coding and made final edits, select{' '}
              <strong>Cancel</strong>. If you are ready to finalize and submit your coding, click{' '}
              <strong style={{ color: '#b8860b' }}>SUBMIT</strong>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                className="btn btn-primary"
                onClick={() => setShowFinalizeModal(false)}
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowFinalizeModal(false); handleSubmit() }}
                style={{ backgroundColor: '#b8860b', color: '#fff', border: 'none', fontWeight: 700, letterSpacing: '0.06em', padding: '0.4rem 1.25rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.95rem' }}
              >
                SUBMIT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page footer ── */}
      <div style={{ textAlign: 'center', padding: '1.5rem 1rem', fontSize: '0.8rem', color: '#aaa', borderTop: '1px solid #e2e8f0', marginTop: '2rem' }}>
        <a href="/GVA_Project_Onboarding.pdf" target="_blank" rel="noopener noreferrer" className="coding-guide-link">
          Coding Guide ↗
        </a>
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
