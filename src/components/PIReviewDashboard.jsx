import { useEffect, useRef, useState } from 'react'
import { parseCSV, getColumnOrder, serializeCSV } from '../lib/csv.js'
import { isRowFlaggedForPI, UNKNOWN_REVIEW_FIELDS, PI_REVIEW_TRIGGERS } from '../hooks/useSampleData.js'

const WORKER_URL = import.meta.env.VITE_WORKER_URL
const PENDING = 'PENDING'

// ── Shooting Type (type_new) two-dropdown structure ───────────────────────────
// Must stay in sync with CodingRow.jsx TYPE_NEW_* constants.

const TYPE_NEW_PRIMARY = ['Suspect-inflicted', 'Self-inflicted', 'Blue-on-blue', 'None', 'Unknown']
const TYPE_NEW_SECONDARY = {
  'Self-inflicted': ['Accidental', 'Intentional/Suicide', 'Unknown'],
  'Blue-on-blue':   ['Accidental', 'Suspect-inflicted', 'Unknown'],
}
const TYPE_NEW_NEEDS_SECONDARY = new Set(['Self-inflicted', 'Blue-on-blue'])

function parseTypeNew(value) {
  if (!value || value === PENDING) return { primary: '', secondary: '' }
  const sep = value.indexOf('; ')
  if (sep === -1) return { primary: value, secondary: '' }
  return { primary: value.slice(0, sep), secondary: value.slice(sep + 2) }
}

// ── Flag labels ───────────────────────────────────────────────────────────────

const FLAG_LABELS = {
  record_added:             'Added Row',
  incident_id_changed:      'ID Changed',
  Status2:                  'Injury Type',
  agencytype:               'Agency Type',
  agencyname:               'Agency Name',
  type_new:                 'Shooting Type',
  notactiveswornlocalstate: 'Active/Sworn',
  offduty:                  'Off Duty',
  training:                 'Training',
  blueonblue:               'Blue on Blue',
  rank:                     'Rank',
  ToRemove:                 'Remove Case',
  CaseSummary:              'Case Summary',
}

function fieldLabel(name) {
  return FLAG_LABELS[name] || name
}

// Single-coder flags: Unknown values + PI trigger fields
function singleCoderFlagsForRow(row) {
  const flags = []
  if (row.record_added === '1') flags.push('Added Row')
  if (row.incident_id_changed === '1') flags.push('ID Changed')
  for (const f of UNKNOWN_REVIEW_FIELDS) {
    if (row[f] === 'Unknown') flags.push(fieldLabel(f))
  }
  return flags
}

// Human-readable display value for the comparison panel
function displayVal(val) {
  if (!val || val === PENDING) return '—'
  return val
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initializeRows(sourceRows, config) {
  const codedFieldNames = new Set([
    ...config.keyColumns.map(c => c.name),
    ...config.supplementaryColumns.map(c => c.name),
    'CaseSummary',
    'Notes',
  ])
  return sourceRows.map(row => {
    const out = { ...row }
    for (const field of codedFieldNames) {
      if (field in out && (out[field] === 'NA' || out[field] === '' || out[field] == null)) {
        out[field] = PENDING
      }
    }
    if (!out.record_added || out.record_added === 'NA' || out.record_added === PENDING) {
      out.record_added = '0'
    }
    return out
  })
}

function exportRows(rows) {
  return rows.map(row => {
    const out = { ...row }
    for (const k of Object.keys(out)) {
      if (out[k] === PENDING) out[k] = 'NA'
    }
    return out
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PIReviewDashboard({ config, token, onBack, onViewCoder }) {
  const [coderData, setCoderData] = useState({})
  const [selected, setSelected]   = useState(null)   // { coderName, rowIdx }
  const [notesPopup, setNotesPopup] = useState(null) // { coderName, rowIdx }

  // Filters
  const [filterPair,  setFilterPair]  = useState('all')
  const [filterCoder, setFilterCoder] = useState('all')
  const [filterFlag,  setFilterFlag]  = useState('all')

  // Save state
  const [saving,         setSaving]        = useState(false)
  const [saveError,      setSaveError]     = useState(null)
  const [saveOk,         setSaveOk]        = useState(false)
  const [lastAutoSaved,  setLastAutoSaved] = useState(null)  // HH:MM:SS string, no state churn

  // Reviewed column: manually submitted incidents (persists for session)
  const [submittedIncidents, setSubmittedIncidents] = useState(new Set())

  // Confirmed custom cases: record_added=1 rows explicitly confirmed by PI
  // Key: `${coderName}:${rowIdx}` — must be confirmed before the incident counts as reconciled
  const [confirmedCustomCases, setConfirmedCustomCases] = useState(new Set())

  // Sort and status filter for the flagged rows table
  const [sortCol,      setSortCol]      = useState(null)   // 'incidentId' | 'rowNum' | null
  const [sortDir,      setSortDir]      = useState('asc')
  const [filterStatus, setFilterStatus] = useState('all')  // 'all' | 'reviewed' | 'pending'
  const [queueSearch,  setQueueSearch]  = useState('')
  const [showConsensus, setShowConsensus] = useState(false)

  // Raw GVA data viewer
  const [showRawData,   setShowRawData]   = useState(false)
  const [rawDataRows,   setRawDataRows]   = useState(null)   // null = not yet fetched
  const [rawDataStatus, setRawDataStatus] = useState('idle') // 'idle' | 'loading' | 'loaded' | 'error'
  const [rawSearch,     setRawSearch]     = useState('')
  const [rawSelected,   setRawSelected]   = useState(null)   // row object for detail panel
  const [rawSortCol,    setRawSortCol]    = useState(null)
  const [rawSortDir,    setRawSortDir]    = useState('asc')

  // Consensus panel state
  const [consensusSearch,   setConsensusSearch]   = useState('')
  const [consensusSortCol,  setConsensusSortCol]  = useState(null)
  const [consensusSortDir,  setConsensusSortDir]  = useState('asc')
  const [expandedConsensusIds, setExpandedConsensusIds] = useState(new Set())

  const autosaveTimerRef  = useRef(null)
  const handleSaveRef     = useRef(null)
  const panelContainerRef = useRef(null)
  const [topPanelHeight, setTopPanelHeight] = useState(300) // px

  // Consensus draft: PI's working values per case, written to consensus on Submit.
  // Key: `${coderName}:${rowIdx}` → { a: rowObj, b: rowObj }
  // Edits here do NOT write back to coder files.
  const [consensusDraft, setConsensusDraft] = useState({})

  // Undo history: each entry is { [coderName]: editedRows_snapshot } for all
  // coders affected by that action. Undo pops and restores all affected coders.
  const [history,      setHistory]      = useState([])
  // Draft undo history: snapshots of consensusDraft before each edit.
  const [draftHistory, setDraftHistory] = useState([])

  // ── Load all coder files in parallel ─────────────────────────────────────
  useEffect(() => {
    if (!config || !token) return

    const initial = {}
    for (const sample of config.samples) {
      for (const [role, nameKey] of [['a', 'coder_a'], ['b', 'coder_b']]) {
        const name = sample[nameKey]
        if (!name) continue
        initial[name] = {
          sampleId:           sample.id,
          role,
          label:              sample.label || `Sample ${sample.id}`,
          rows:               [],
          columnOrder:        [],
          editedRows:         null,
          originalFlaggedSet: new Set(),
          status:             'loading',
          error:              null,
        }
      }
    }
    setCoderData(initial)

    for (const [name, info] of Object.entries(initial)) {
      fetch(`${WORKER_URL}/sample?sampleId=${info.sampleId}&role=${info.role}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.text()
        })
        .then(text => {
          const columnOrder = getColumnOrder(text)
          const parsed      = parseCSV(text)
          const rows        = initializeRows(parsed, config)
          const originalFlaggedSet = new Set(
            rows
              .map((row, idx) => ({ row, idx }))
              .filter(({ row }) => isRowFlaggedForPI(row))
              .map(({ idx }) => idx)
          )
          setCoderData(prev => ({
            ...prev,
            [name]: { ...prev[name], rows, columnOrder, originalFlaggedSet, status: 'loaded' },
          }))
        })
        .catch(e => {
          setCoderData(prev => ({
            ...prev,
            [name]: { ...prev[name], status: 'error', error: e.message },
          }))
        })
    }
  }, [config, token])

  // ── Fetch raw GVA data on first open ──────────────────────────────────────
  useEffect(() => {
    if (!showRawData || rawDataStatus !== 'idle') return
    setRawDataStatus('loading')
    fetch(`${WORKER_URL}/rawdata`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => { setRawDataRows(parseCSV(text)); setRawDataStatus('loaded') })
      .catch(() => setRawDataStatus('error'))
  }, [showRawData, rawDataStatus, token])

  // ── Derived state ─────────────────────────────────────────────────────────

  const totalCoders   = Object.keys(coderData).length
  const loadedCount   = Object.values(coderData).filter(d => d.status === 'loaded').length
  const errorCount    = Object.values(coderData).filter(d => d.status === 'error').length
  const allLoaded     = totalCoders > 0 && loadedCount + errorCount === totalCoders
  const pairs         = config.samples.map(s => ({ id: s.id, label: s.label || `Sample ${s.id}` }))
  const coderNames    = Object.keys(coderData).sort()
  const filtersActive = filterPair !== 'all' || filterCoder !== 'all' || filterFlag !== 'all' || filterStatus !== 'all' || queueSearch.trim() !== ''

  const keyFieldNames = config.keyColumns.map(c => c.name)

  // ── IRR disagreement detection (derived, recomputed on every render) ──────
  const disagreementsByCoderRow = {}
  for (const sample of config.samples) {
    const nameA = sample.coder_a
    const nameB = sample.coder_b
    if (!nameA || !nameB) continue
    const infoA = coderData[nameA]
    const infoB = coderData[nameB]
    if (infoA?.status !== 'loaded' || infoB?.status !== 'loaded') continue

    const rowsA = infoA.editedRows ?? infoA.rows
    const rowsB = infoB.editedRows ?? infoB.rows
    disagreementsByCoderRow[nameA] = {}
    disagreementsByCoderRow[nameB] = {}

    const minLen = Math.min(rowsA.length, rowsB.length)
    for (let i = 0; i < minLen; i++) {
      const diffs = new Set()
      for (const field of keyFieldNames) {
        const vA = rowsA[i][field]
        const vB = rowsB[i][field]
        if (vA && vA !== PENDING && vB && vB !== PENDING && vA !== vB) {
          diffs.add(field)
        }
      }
      if (diffs.size > 0) {
        disagreementsByCoderRow[nameA][i] = diffs
        disagreementsByCoderRow[nameB][i] = diffs
      }
    }
  }

  // ── Reconciled incidents + rows: derived from live coderData each render ──
  // reconciledIncidents: `coderName:iid` — ALL rows for that incident pass.
  // reconciledRows:      `coderName:iid:idx` — this individual row passes.
  // Recomputed on every render so Undo automatically reflects here.
  const reconciledIncidents = new Set()
  const reconciledRows      = new Set()
  for (const [coderName, info] of Object.entries(coderData)) {
    if (info.status !== 'loaded') continue
    const currentRows        = info.editedRows ?? info.rows
    const coderDisagreements = disagreementsByCoderRow[coderName] ?? {}
    const byIncident = {}
    currentRows.forEach((row, idx) => {
      const iid = String(row[config.idColumn])
      if (!byIncident[iid]) byIncident[iid] = []
      byIncident[iid].push(idx)
    })
    for (const [iid, indices] of Object.entries(byIncident)) {
      let allOk = true
      for (const idx of indices) {
        const row = currentRows[idx]
        const rowOk =
          (coderDisagreements[idx]?.size ?? 0) === 0 &&
          !keyFieldNames.some(f => row[f] === 'Unknown') &&
          !keyFieldNames.some(f => !row[f] || row[f] === PENDING) &&
          !(row.record_added === '1' && !confirmedCustomCases.has(`${coderName}:${idx}`))
        if (rowOk) reconciledRows.add(`${coderName}:${iid}:${idx}`)
        else allOk = false
      }
      if (allOk) reconciledIncidents.add(`${coderName}:${iid}`)
    }
  }

  // Unique fully-reconciled incident IDs (used for counter + green check in queue table)
  const reconciledIncidentIds = new Set(
    [...reconciledIncidents].map(k => k.substring(k.indexOf(':') + 1))
  )

  // Build rows for the consensus panel.
  // Include any incident where AT LEAST ONE of coder A's rows is reconciled.
  // Each entry carries allReconciled (all rows ok) and reconciledMask (per-row boolean).
  const consensusTableRows = []
  for (const sample of config.samples) {
    const coderAName = sample.coder_a
    if (!coderAName) continue
    const info = coderData[coderAName]
    if (info?.status !== 'loaded') continue
    const currentRows = info.editedRows ?? info.rows
    const byIncident = {}
    currentRows.forEach((row, idx) => {
      const iid = String(row[config.idColumn])
      if (!byIncident[iid]) byIncident[iid] = []
      byIncident[iid].push({ row, idx })
    })
    for (const [iid, entries] of Object.entries(byIncident)) {
      const reconciledMask = entries.map(({ idx }) => reconciledRows.has(`${coderAName}:${iid}:${idx}`))
      if (!reconciledMask.some(Boolean)) continue  // no rows reconciled — skip entirely
      consensusTableRows.push({
        incidentId:    iid,
        sampleLabel:   info.label,
        rows:          entries.map(e => e.row),
        piSubmitted:   submittedIncidents.has(iid),
        allReconciled: reconciledIncidents.has(`${coderAName}:${iid}`),
        reconciledMask,
      })
    }
  }
  consensusTableRows.sort((a, b) =>
    String(a.incidentId).localeCompare(String(b.incidentId), undefined, { numeric: true })
  )
  const consensusRowCount = consensusTableRows.reduce((sum, c) => sum + c.rows.length, 0)

  // Filtered + sorted consensus rows
  const consensusSearchLower = consensusSearch.trim().toLowerCase()
  const filteredConsensus = consensusTableRows
    .filter(({ incidentId, sampleLabel, rows }) => {
      if (!consensusSearchLower) return true
      const rep = rows[0]
      return (
        String(incidentId).includes(consensusSearchLower) ||
        sampleLabel.toLowerCase().includes(consensusSearchLower) ||
        (rep.Cityorcounty || '').toLowerCase().includes(consensusSearchLower) ||
        (rep.State        || '').toLowerCase().includes(consensusSearchLower) ||
        (rep.agencyname   || '').toLowerCase().includes(consensusSearchLower) ||
        (rep.Status2      || '').toLowerCase().includes(consensusSearchLower) ||
        (rep.agencytype   || '').toLowerCase().includes(consensusSearchLower) ||
        (rep.type_new     || '').toLowerCase().includes(consensusSearchLower)
      )
    })
    .sort((a, b) => {
      if (!consensusSortCol) return 0
      if (consensusSortCol === 'rows') {
        return consensusSortDir === 'asc' ? a.rows.length - b.rows.length : b.rows.length - a.rows.length
      }
      const field = consensusSortCol
      const va = field === 'incidentId' ? String(a.incidentId) : (a.rows[0][field] || '')
      const vb = field === 'incidentId' ? String(b.incidentId) : (b.rows[0][field] || '')
      const cmp = va.localeCompare(vb, undefined, { numeric: true })
      return consensusSortDir === 'asc' ? cmp : -cmp
    })

  // ── Flagged rows list ─────────────────────────────────────────────────────
  // Only emit one entry per case — use coder A as the anchor for each pair.
  // The comparison panel looks up the partner automatically.
  const allFlagged = []
  for (const [coderName, info] of Object.entries(coderData)) {
    if (info.status !== 'loaded') continue
    if (info.role !== 'a') continue  // skip coder B — avoids double-counting
    if (filterPair !== 'all' && String(info.sampleId) !== filterPair) continue
    if (filterCoder !== 'all') {
      const sample = config.samples.find(s => s.id === info.sampleId)
      const pairPartner = sample?.coder_b  // info.role === 'a' always here
      if (coderName !== filterCoder && pairPartner !== filterCoder) continue
    }

    const currentRows        = info.editedRows ?? info.rows
    const coderDisagreements = disagreementsByCoderRow[coderName] ?? {}

    // Uncoded rows: every key field is blank/PENDING/NA
    const uncodedIdxs = new Set(
      currentRows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => keyFieldNames.every(f => {
          const v = row[f]; return !v || v === '' || v === 'NA' || v === PENDING
        }))
        .map(({ idx }) => idx)
    )

    const allRowIdxs = new Set([
      ...info.originalFlaggedSet,
      ...Object.keys(coderDisagreements).map(Number),
      ...uncodedIdxs,
    ])

    for (const rowIdx of allRowIdxs) {
      const row         = currentRows[rowIdx]
      const singleFlags = singleCoderFlagsForRow(row)
      const disagreed   = coderDisagreements[rowIdx] ?? new Set()
      const isUncoded   = uncodedIdxs.has(rowIdx)
      const flags       = [
        ...(isUncoded ? ['Uncoded Case'] : []),
        ...singleFlags,
        ...[...disagreed].map(f => `≠ ${fieldLabel(f)}`),
      ]
      const isCleared = !isUncoded && singleFlags.length === 0 && disagreed.size === 0

      if (filterFlag !== 'all') {
        if (isCleared) continue
        if (filterFlag === 'record_added'        && row.record_added !== '1')                               continue
        if (filterFlag === 'incident_id_changed'  && row.incident_id_changed !== '1')                       continue
        if (filterFlag === 'unknown'              && !UNKNOWN_REVIEW_FIELDS.some(f => row[f] === 'Unknown')) continue
        if (filterFlag === 'disagreement'         && disagreed.size === 0)                                   continue
        if (filterFlag === 'uncoded'              && !isUncoded)                                             continue
      }

      const incidentIdStr = String(row[config.idColumn])
      const isReconciled = reconciledIncidents.has(`${coderName}:${incidentIdStr}`)
      if (filterStatus === 'conflicted' && (isReconciled || submittedIncidents.has(incidentIdStr))) continue
      if (filterStatus === 'ready'      && (!isReconciled || submittedIncidents.has(incidentIdStr))) continue

      allFlagged.push({ coderName, info, row, rowIdx, flags, isCleared, disagreed, isUncoded })
    }
  }
  if (sortCol === 'incidentId') {
    allFlagged.sort((a, b) => {
      const cmp = String(a.row[config.idColumn]).localeCompare(String(b.row[config.idColumn]), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  } else if (sortCol === 'rowNum') {
    allFlagged.sort((a, b) => sortDir === 'asc' ? a.rowIdx - b.rowIdx : b.rowIdx - a.rowIdx)
  } else {
    allFlagged.sort((a, b) =>
      a.info.sampleId - b.info.sampleId ||
      a.coderName.localeCompare(b.coderName) ||
      a.rowIdx - b.rowIdx
    )
  }
  const queueSearchLower = queueSearch.trim().toLowerCase()
  const allFlaggedFiltered = queueSearchLower
    ? allFlagged.filter(({ coderName, row }) => {
        const id    = String(row[config.idColumn] || '').toLowerCase()
        const city  = String(row.Cityorcounty || '').toLowerCase()
        const state = String(row.State || '').toLowerCase()
        const coder = coderName.toLowerCase()
        return id.includes(queueSearchLower) || city.includes(queueSearchLower) || state.includes(queueSearchLower) || coder.includes(queueSearchLower)
      })
    : allFlagged

  // ── Selected row + partner ────────────────────────────────────────────────

  const selectedInfo = selected ? coderData[selected.coderName] : null
  const selectedRows = selectedInfo?.editedRows ?? selectedInfo?.rows ?? []
  const selectedRow  = selected ? selectedRows[selected.rowIdx] : null
  const hasEdits     = selected && !!coderData[selected.coderName]?.editedRows

  // Find the partner coder for the selected sample
  const selectedSample = config.samples.find(s => s.id === selectedInfo?.sampleId)
  const partnerName = selectedInfo?.role === 'a'
    ? selectedSample?.coder_b
    : selectedSample?.coder_a
  const partnerInfo = partnerName ? coderData[partnerName] : null
  const partnerRows = partnerInfo?.editedRows ?? partnerInfo?.rows ?? []
  const partnerRow  = selected ? partnerRows[selected.rowIdx] : null

  // Consensus draft derived values for the selected case
  const draftKey     = selected ? `${selected.coderName}:${selected.rowIdx}` : null
  const currentDraft = draftKey ? (consensusDraft[draftKey] ?? null) : null
  const draftA       = currentDraft?.a ?? selectedRow
  const draftB       = currentDraft?.b ?? partnerRow

  // Fields shown in the comparison panel (now all config columns):
  const allConfigColumns = [...config.keyColumns, ...config.supplementaryColumns]
  const alwaysShowFields = new Set([...keyFieldNames, 'agencyname'])
  const comparisonFields = (() => {
    const fields = allConfigColumns.filter(col => {
      if (alwaysShowFields.has(col.name)) return true
      if (col.type !== 'controlled_vocab') return false
      if (!selectedRow || !partnerRow) return false
      const vSel = selectedRow[col.name]
      const vPar = partnerRow[col.name]
      const bothBlank = (!vSel || vSel === PENDING) && (!vPar || vPar === PENDING)
      // Also show fields where both coders agreed on Unknown — that still needs addressing
      if (vSel === vPar && vSel === 'Unknown') return true
      return !bothBlank && vSel !== vPar
    })
    // Ensure agencyname immediately follows agencytype
    const nameIdx = fields.findIndex(c => c.name === 'agencyname')
    const typeIdx = fields.findIndex(c => c.name === 'agencytype')
    if (nameIdx !== -1 && typeIdx !== -1 && nameIdx !== typeIdx + 1) {
      const [col] = fields.splice(nameIdx, 1)
      fields.splice(typeIdx + 1, 0, col)
    }
    return fields
  })()

  // Remaining disagreements on the selected row
  const selectedDisagreements = selected
    ? (disagreementsByCoderRow[selected.coderName]?.[selected.rowIdx] ?? new Set())
    : new Set()

  // Remaining disagreements across ALL rows for the selected incident
  const selectedIncidentId = selectedRow?.[config.idColumn]
  const incidentRowIdxs = selectedRow
    ? (selectedRows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => row[config.idColumn] === selectedIncidentId)
        .map(({ idx }) => idx))
    : []
  const incidentFullyReconciled =
    incidentRowIdxs.length > 0 &&
    incidentRowIdxs.every(idx => {
      if ((disagreementsByCoderRow[selected?.coderName]?.[idx]?.size ?? 0) > 0) return false
      const row = selectedRows[idx]
      if (keyFieldNames.some(f => row[f] === 'Unknown')) return false
      if (keyFieldNames.some(f => !row[f] || row[f] === PENDING)) return false
      return true
    })

  // ── Red-border field set ──────────────────────────────────────────────────
  // Flags a field when: Unknown, blank/PENDING key field, or disagreed with partner.
  // Clears reactively as PI resolves each issue.
  const flaggedFieldSet = selectedRow ? new Set([
    ...UNKNOWN_REVIEW_FIELDS.filter(f => selectedRow[f] === 'Unknown'),
    ...PI_REVIEW_TRIGGERS.filter(f => selectedRow[f] === '1'),
    ...keyFieldNames.filter(f =>
      selectedRow[f] === PENDING || selectedRow[f] === '' || selectedRow[f] == null
    ),
    ...selectedDisagreements,
  ]) : new Set()

  // ── Autosave: debounced save on any edit ─────────────────────────────────
  // handleSaveRef is updated each render so the timeout always calls the
  // latest version (no stale-closure issues).
  handleSaveRef.current = async function handleSaveLatest() {
    if (!selected || !selectedRow) return
    const { coderName } = selected
    const info          = coderData[coderName]
    if (!info?.editedRows) return          // nothing to save

    const incidentId   = selectedRow[config.idColumn]
    const allRows      = exportRows(info.editedRows ?? info.rows)
    const incidentRows = allRows.filter(r => String(r[config.idColumn]) === String(incidentId))
    const csvString    = serializeCSV(incidentRows, info.columnOrder)
    try {
      const res = await fetch(`${WORKER_URL}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: csvString, sampleId: info.sampleId, role: info.role, incidentId, destination: 'pi_review' }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      // No local state mutations — avoids re-rendering CodingRow and
      // interrupting textarea cursor position mid-typing.
      setLastAutoSaved(new Date().toLocaleTimeString())
    } catch (e) {
      setSaveError(e.message)
    }
  }

  useEffect(() => {
    if (!selected || !hasEdits) {
      clearTimeout(autosaveTimerRef.current)
      return
    }
    clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => {
      handleSaveRef.current?.()
    }, 2000)
    return () => clearTimeout(autosaveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.coderName, selected?.rowIdx, hasEdits, coderData])

  // ── Notes popup data ──────────────────────────────────────────────────────
  const popupCoder = notesPopup ? coderData[notesPopup.coderName] : null
  const popupRows  = popupCoder?.editedRows ?? popupCoder?.rows ?? []
  const popupRow   = notesPopup ? popupRows[notesPopup.rowIdx] : null
  const popupNotes = popupRow
    ? (popupRow.Notes && popupRow.Notes !== 'NA' && popupRow.Notes !== PENDING ? popupRow.Notes : null)
    : null

  // ── Handlers ─────────────────────────────────────────────────────────────

  // ── Undo helpers ─────────────────────────────────────────────────────────

  // Capture the current editedRows for each named coder before a change.
  // Called synchronously before any setCoderData so the snapshot is accurate.
  function pushHistory(coderNames) {
    const snapshot = {}
    for (const name of coderNames) {
      if (name) snapshot[name] = coderData[name]?.editedRows ?? null
    }
    setHistory(prev => [...prev.slice(-29), snapshot])
  }

  function handleUndo() {
    // Prefer undoing draft edits first; fall back to coderData history.
    if (draftHistory.length > 0) {
      const snapshot = draftHistory[draftHistory.length - 1]
      setDraftHistory(prev => prev.slice(0, -1))
      setConsensusDraft(snapshot)
      return
    }
    if (history.length === 0) return
    const snapshot = history[history.length - 1]
    setHistory(prev => prev.slice(0, -1))
    setCoderData(prev => {
      const next = { ...prev }
      for (const [name, editedRows] of Object.entries(snapshot)) {
        next[name] = { ...prev[name], editedRows }
      }
      return next
    })
    setSaveOk(false)
  }

  // ── Edit handlers ─────────────────────────────────────────────────────────

  function handleRowChange(fieldName, value) {
    if (!selected) return
    const { coderName, rowIdx } = selected
    pushHistory([coderName])
    setCoderData(prev => {
      const info    = prev[coderName]
      const base    = info.editedRows ?? info.rows
      const updated = [...base]
      updated[rowIdx] = { ...updated[rowIdx], [fieldName]: value }
      return { ...prev, [coderName]: { ...info, editedRows: updated } }
    })
    setSaveOk(false)
  }

  // Copy a field value to the PARTNER coder
  function copyFieldToPartner(fieldName, value) {
    if (!partnerName || selected === null) return
    pushHistory([partnerName])
    setCoderData(prev => {
      const info    = prev[partnerName]
      const base    = info.editedRows ?? info.rows
      const updated = [...base]
      updated[selected.rowIdx] = { ...updated[selected.rowIdx], [fieldName]: value }
      return { ...prev, [partnerName]: { ...info, editedRows: updated } }
    })
    setSaveOk(false)
  }

  // Copy one field value to BOTH coders in a single batched update
  function copyFieldToBoth(fieldName, value) {
    if (!selected) return
    pushHistory([selected.coderName, partnerName])
    setCoderData(prev => {
      const next = { ...prev }
      const selInfo = prev[selected.coderName]
      const selBase = selInfo.editedRows ?? selInfo.rows
      const selUpd  = [...selBase]
      selUpd[selected.rowIdx] = { ...selUpd[selected.rowIdx], [fieldName]: value }
      next[selected.coderName] = { ...selInfo, editedRows: selUpd }
      if (partnerName) {
        const parInfo = prev[partnerName]
        const parBase = parInfo.editedRows ?? parInfo.rows
        const parUpd  = [...parBase]
        parUpd[selected.rowIdx] = { ...parUpd[selected.rowIdx], [fieldName]: value }
        next[partnerName] = { ...parInfo, editedRows: parUpd }
      }
      return next
    })
    setSaveOk(false)
  }

  // Fields that are raw GVA data — never overwritten by copy operations
  const RAW_GVA_FIELD_SET = new Set([
    'IncidentID', 'Date', 'State', 'Cityorcounty', 'BusinessorLocation',
    'Address', 'Latitude', 'Longitude', 'Name', 'Type', 'Gender', 'Age',
    'Agegroup', 'Status', 'Incidentcharacteristics', 'Sources', 'base_row_num',
  ])

  // Copy ALL project-added fields from the selected coder → partner
  function copyAllToPartner() {
    if (!selectedRow || !partnerName || selected === null) return
    pushHistory([partnerName])
    setCoderData(prev => {
      const info    = prev[partnerName]
      const base    = info.editedRows ?? info.rows
      const updated = [...base]
      const merged  = { ...updated[selected.rowIdx] }
      for (const f of Object.keys(selectedRow)) {
        if (!RAW_GVA_FIELD_SET.has(f)) merged[f] = selectedRow[f] ?? ''
      }
      updated[selected.rowIdx] = merged
      return { ...prev, [partnerName]: { ...info, editedRows: updated } }
    })
    setSaveOk(false)
  }

  // Copy ALL project-added fields from partner → selected coder
  function copyAllFromPartner() {
    if (!partnerRow || selected === null) return
    pushHistory([selected.coderName])
    setCoderData(prev => {
      const info    = prev[selected.coderName]
      const base    = info.editedRows ?? info.rows
      const updated = [...base]
      const merged  = { ...updated[selected.rowIdx] }
      for (const f of Object.keys(partnerRow)) {
        if (!RAW_GVA_FIELD_SET.has(f)) merged[f] = partnerRow[f] ?? ''
      }
      updated[selected.rowIdx] = merged
      return { ...prev, [selected.coderName]: { ...info, editedRows: updated } }
    })
    setSaveOk(false)
  }

  // Update a single field in the consensus draft for the selected case.
  // Does NOT write to any coder file — only updates local draft state.
  function handleDraftChange(side, fieldName, value) {
    if (!selected || !selectedRow || !partnerRow) return
    const key = `${selected.coderName}:${selected.rowIdx}`
    setDraftHistory(prev => [...prev, consensusDraft])
    setConsensusDraft(prev => {
      const current = prev[key] || { a: { ...selectedRow }, b: { ...partnerRow } }
      return { ...prev, [key]: { ...current, [side]: { ...current[side], [fieldName]: value } } }
    })
  }

  // ── Save handler (per-incident to pi_reviewed_dir) ────────────────────────
  async function handleSave() {
    if (!selected || !selectedRow) return
    const { coderName } = selected
    const info          = coderData[coderName]
    const incidentId    = selectedRow[config.idColumn]

    setSaving(true)
    setSaveError(null)
    setSaveOk(false)

    // Extract only rows for this incident — preserves all rows in the incident group
    const allRows        = exportRows(info.editedRows ?? info.rows)
    const incidentRows   = allRows.filter(r => String(r[config.idColumn]) === String(incidentId))
    const csvString      = serializeCSV(incidentRows, info.columnOrder)

    try {
      const res = await fetch(`${WORKER_URL}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          content:     csvString,
          sampleId:    info.sampleId,
          role:        info.role,
          incidentId:  incidentId,
          destination: 'pi_review',
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      // Commit edits
      setCoderData(prev => ({
        ...prev,
        [coderName]: { ...prev[coderName], rows: info.editedRows ?? info.rows, editedRows: null },
      }))
      setSaveOk(true)
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Confirm custom case handler ───────────────────────────────────────────
  function handleConfirmCase() {
    if (!selected) return
    const { coderName, rowIdx } = selected
    setConfirmedCustomCases(prev => new Set([...prev, `${coderName}:${rowIdx}`]))
  }

  // ── Submit handler: PI confirms reconciliation and writes to pi_reviewed_cases.csv ──
  async function handleSubmit(coderName, incidentId, rowIdx, e) {
    e.stopPropagation()

    const info = coderData[coderName]
    if (!info) return

    const currentRows = info.editedRows ?? info.rows

    // For each row of this incident, use the consensus draft if one exists,
    // otherwise fall back to the coder's original row.
    const incidentRows = exportRows(
      currentRows
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => String(r[config.idColumn]) === String(incidentId))
        .map(({ r, idx }) => {
          const key = `${coderName}:${idx}`
          return consensusDraft[key]?.a ?? r
        })
    )
    const csvString = serializeCSV(incidentRows, info.columnOrder)

    try {
      const res = await fetch(`${WORKER_URL}/write`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          content:     csvString,
          incidentId:  incidentId,
          destination: 'pi_reviewed',
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSubmittedIncidents(prev => new Set([...prev, String(incidentId)]))
    } catch (err) {
      setSaveError(`Submit failed: ${err.message}`)
    }
  }

  // ── Sort handler ─────────────────────────────────────────────────────────
  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  function handleConsensusSort(col) {
    if (consensusSortCol === col) setConsensusSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setConsensusSortCol(col); setConsensusSortDir('asc') }
  }

  function handleRawSort(col) {
    if (rawSortCol === col) setRawSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setRawSortCol(col); setRawSortDir('asc') }
  }

  function toggleConsensusExpand(incidentId) {
    setExpandedConsensusIds(prev => {
      const next = new Set(prev)
      if (next.has(incidentId)) next.delete(incidentId); else next.add(incidentId)
      return next
    })
  }

  function handleSendToQueue(incidentId, sampleLabel) {
    setShowConsensus(false)
    const flaggedRow = allFlagged.find(f => String(f.row[config.idColumn]) === String(incidentId))
    if (flaggedRow) { setSelected({ coderName: flaggedRow.coderName, rowIdx: flaggedRow.rowIdx }); return }
    // Auto-agreed: navigate to coder A's row in the editor
    const sample = config.samples.find(s => (s.label || `Sample ${s.id}`) === sampleLabel)
    if (sample?.coder_a) {
      const info = coderData[sample.coder_a]
      if (info?.status === 'loaded') {
        const rows = info.editedRows ?? info.rows
        const rowIdx = rows.findIndex(r => String(r[config.idColumn]) === String(incidentId))
        if (rowIdx !== -1) setSelected({ coderName: sample.coder_a, rowIdx })
      }
    }
  }

  // ── Divider drag ─────────────────────────────────────────────────────────
  function handleDividerMouseDown(e) {
    e.preventDefault()
    const container = panelContainerRef.current
    if (!container) return
    const startY      = e.clientY
    const startHeight = topPanelHeight

    function onMouseMove(ev) {
      const delta     = ev.clientY - startY
      const available = container.clientHeight
      const next      = Math.min(Math.max(startHeight + delta, 80), available - 80)
      setTopPanelHeight(next)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup',   onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup',   onMouseUp)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const hasPartner = !!(partnerName && partnerRow)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* ── Raw GVA Data modal ── */}
      {showRawData && (() => {
        const RAW_COLS = [
          { key: 'IncidentID',    label: 'ID' },
          { key: 'Date',          label: 'Date' },
          { key: 'State',         label: 'State' },
          { key: 'Cityorcounty',  label: 'City/County' },
          { key: 'Name',          label: 'Name' },
          { key: 'Gender',        label: 'Gender' },
          { key: 'Age',           label: 'Age' },
          { key: 'Status',        label: 'Status' },
        ]
        const searchLower = rawSearch.trim().toLowerCase()
        const filteredUnsorted = (rawDataRows || []).filter(row =>
          !searchLower ||
          Object.values(row).some(v => String(v).toLowerCase().includes(searchLower))
        )
        const filtered = rawSortCol
          ? [...filteredUnsorted].sort((a, b) => {
              const av = rawSortCol === '_rowCount' ? (rowCountById[String(a.IncidentID)] || 0) : (a[rawSortCol] || '')
              const bv = rawSortCol === '_rowCount' ? (rowCountById[String(b.IncidentID)] || 0) : (b[rawSortCol] || '')
              const cmp = typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : String(av).localeCompare(String(bv), undefined, { numeric: true })
              return rawSortDir === 'asc' ? cmp : -cmp
            })
          : filteredUnsorted
        // Group: how many rows per incident ID
        const rowCountById = {}
        for (const row of (rawDataRows || [])) {
          const id = String(row.IncidentID)
          rowCountById[id] = (rowCountById[id] || 0) + 1
        }
        return (
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
              zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              style={{
                background: '#fff', borderRadius: '6px', width: '95vw', height: '92vh',
                display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.28)',
              }}
            >
              {/* Modal header */}
              <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
                <strong style={{ fontSize: '1rem' }}>Raw GVA Data — 2024–2025</strong>
                {rawDataStatus === 'loaded' && (
                  <span style={{ fontSize: '0.8rem', color: '#666' }}>
                    {filtered.length} of {rawDataRows.length} rows
                    {searchLower && ` matching "${rawSearch}"`}
                  </span>
                )}
                <input
                  type="text"
                  value={rawSearch}
                  onChange={e => { setRawSearch(e.target.value); setRawSelected(null) }}
                  placeholder="Search by ID, name, city, state…"
                  style={{ flex: 1, maxWidth: '28rem', padding: '0.3rem 0.6rem', border: '1px solid #cbd5e0', borderRadius: '4px', fontSize: '0.875rem' }}
                  autoFocus
                />
                {rawSearch && (
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => { setRawSearch(''); setRawSelected(null) }}>
                    Clear
                  </button>
                )}
                <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setShowRawData(false)}>
                  Close
                </button>
              </div>

              {/* Modal body */}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {rawDataStatus === 'loading' && (
                  <div style={{ padding: '2rem', color: '#666' }}>Loading base CSV…</div>
                )}
                {rawDataStatus === 'error' && (
                  <div style={{ padding: '2rem', color: '#c53030' }}>Failed to load raw data. Check worker logs.</div>
                )}
                {rawDataStatus === 'loaded' && (
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                    <table className="pi-review-table" style={{ width: '100%', fontSize: '0.8rem' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
                        <tr>
                          {RAW_COLS.map(c => (
                            <th
                              key={c.key}
                              style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
                              onClick={() => handleRawSort(c.key)}
                            >
                              {c.label}
                              {rawSortCol === c.key ? (rawSortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                            </th>
                          ))}
                          <th
                            style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
                            onClick={() => handleRawSort('_rowCount')}
                          >
                            Rows in GVA{rawSortCol === '_rowCount' ? (rawSortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((row, i) => {
                          const iid       = String(row.IncidentID)
                          const isHighlit = iid === String(rawSearch.trim()) || (selectedRow && iid === String(selectedRow[config.idColumn]))
                          const isSelRow  = rawSelected === row
                          return (
                            <tr
                              key={i}
                              onClick={() => setRawSelected(isSelRow ? null : row)}
                              style={{
                                cursor: 'pointer',
                                background: isSelRow ? '#ebf4ff' : isHighlit ? '#fefce8' : undefined,
                                borderLeft: isSelRow ? '3px solid #3182ce' : isHighlit ? '3px solid #d97706' : '3px solid transparent',
                              }}
                            >
                              {RAW_COLS.map(c => (
                                <td key={c.key} style={{ whiteSpace: c.key === 'Name' ? 'nowrap' : undefined }}>
                                  {c.key === 'IncidentID' ? <code>{row[c.key]}</code> : (row[c.key] || '—')}
                                </td>
                              ))}
                              <td style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontWeight: (rowCountById[iid] || 0) > 1 ? 700 : undefined,
                                  color:      (rowCountById[iid] || 0) > 1 ? '#c05621' : undefined,
                                }}>
                                  {rowCountById[iid] || 1}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Detail panel for selected row */}
                {rawSelected && (
                  <div style={{ flexShrink: 0, borderTop: '2px solid #bee3f8', background: '#ebf8ff', padding: '0.75rem 1.25rem', maxHeight: '35%', overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <strong style={{ fontSize: '0.875rem' }}>Incident {rawSelected.IncidentID} — Full Details</strong>
                      <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => setRawSelected(null)}>Dismiss</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem 2rem', fontSize: '0.8rem' }}>
                      {['Date','State','Cityorcounty','Address','BusinessorLocation','Name','Type','Gender','Age','Agegroup','Status'].map(k => (
                        rawSelected[k] && rawSelected[k] !== 'NA' ? (
                          <div key={k}><span style={{ color: '#555', fontWeight: 600 }}>{k}:</span> {rawSelected[k]}</div>
                        ) : null
                      ))}
                    </div>
                    {rawSelected.Incidentcharacteristics && rawSelected.Incidentcharacteristics !== 'NA' && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                        <span style={{ color: '#555', fontWeight: 600 }}>Characteristics:</span>
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0.2rem 0 0', fontFamily: 'inherit', fontSize: '0.8rem', lineHeight: 1.5 }}>
                          {rawSelected.Incidentcharacteristics}
                        </pre>
                      </div>
                    )}
                    {rawSelected.Sources && rawSelected.Sources !== 'NA' && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                        <span style={{ color: '#555', fontWeight: 600 }}>Sources:</span>
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0.2rem 0 0', fontFamily: 'inherit', fontSize: '0.75rem', lineHeight: 1.5, color: '#2b6cb0' }}>
                          {rawSelected.Sources}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Notes popup modal ── */}
      {notesPopup && popupNotes && (
        <div
          onClick={() => setNotesPopup(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: '6px', padding: '1.5rem',
              maxWidth: '56rem', width: '90%', maxHeight: '80vh',
              overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.22)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <strong style={{ fontSize: '0.95rem' }}>{notesPopup.coderName}</strong>
                <span style={{ color: '#666', fontSize: '0.85rem', marginLeft: '0.75rem' }}>
                  Row {notesPopup.rowIdx + 1} · Incident {popupRow?.[config.idColumn]}
                </span>
              </div>
              <button className="btn btn-secondary" style={{ fontSize: '0.8rem', marginLeft: '1rem', flexShrink: 0 }} onClick={() => setNotesPopup(null)}>
                Close
              </button>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: '0.875rem', lineHeight: '1.6', margin: 0 }}>
              {popupNotes}
            </pre>
          </div>
        </div>
      )}

      {/* ── Sticky header ── */}
      <div className="table-header" style={{ flexShrink: 0 }}>
        <div>
          <h2>PI Review Queue</h2>
          <div style={{ fontSize: '0.8rem', color: '#666', display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
            <span>
              {allLoaded
                ? `${allFlagged.length} flagged row${allFlagged.length !== 1 ? 's' : ''} across ${loadedCount} coder${loadedCount !== 1 ? 's' : ''}`
                : `Loading… ${loadedCount} / ${totalCoders} coders`}
            </span>
            {allLoaded && (
              <span style={{ color: '#276749', fontWeight: 600 }}>
                {reconciledIncidentIds.size} incident{reconciledIncidentIds.size !== 1 ? 's' : ''} / {consensusRowCount} row{consensusRowCount !== 1 ? 's' : ''} in consensus
              </span>
            )}
          </div>
        </div>
        <div className="table-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <button className="btn btn-secondary" onClick={onBack}>← Back</button>
          <div style={{ flex: 1 }} />
          {(history.length > 0 || draftHistory.length > 0) && (
            <button className="btn btn-secondary" onClick={handleUndo}>↩ Undo</button>
          )}
          {saveError && (
            <span style={{ fontSize: '0.85rem', color: '#c53030' }}>{saveError}</span>
          )}
          <button
            className={`btn ${showRawData ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              const opening = !showRawData
              setShowRawData(opening)
              if (opening && selectedRow) setRawSearch(String(selectedRow[config.idColumn]))
            }}
          >
            {showRawData ? 'Close GVA Data' : 'Review Raw GVA Data'}
          </button>
          <button
            className={`btn ${showConsensus ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              const opening = !showConsensus
              setShowConsensus(opening)
              if (opening && selectedRow) setConsensusSearch(String(selectedRow[config.idColumn]))
            }}
          >
            {showConsensus ? 'PI Review Queue' : 'Review Consensus Records'}
          </button>
        </div>
        {lastAutoSaved && (
          <div className="autosave-indicator">Autosaved {lastAutoSaved}</div>
        )}
        <div className="header-progress-bar">
          <div className="header-progress-fill" style={{ width: totalCoders > 0 ? `${Math.round((loadedCount / totalCoders) * 100)}%` : '0%' }} />
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', gap: '1.25rem', padding: '0.6rem 1.25rem', background: '#f8f9fa', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
          Pair
          <select value={filterPair} onChange={e => { setFilterPair(e.target.value); setFilterCoder('all') }}>
            <option value="all">All pairs</option>
            {pairs.map(p => <option key={p.id} value={String(p.id)}>{p.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
          Coder
          <select value={filterCoder} onChange={e => setFilterCoder(e.target.value)}>
            <option value="all">All coders</option>
            {(filterPair === 'all'
              ? coderNames
              : coderNames.filter(n => String(coderData[n]?.sampleId) === filterPair)
            ).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {!showConsensus && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
              Flag type
              <select value={filterFlag} onChange={e => setFilterFlag(e.target.value)}>
                <option value="all">All flags</option>
                <option value="disagreement">Coder disagreement</option>
                <option value="unknown">Unknown field</option>
                <option value="record_added">Added row</option>
                <option value="incident_id_changed">ID changed</option>
                <option value="uncoded">Uncoded case</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
              Status
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="all">All</option>
                <option value="conflicted">Conflicted</option>
                <option value="ready">Ready to Confirm</option>
              </select>
            </label>
          </>
        )}
        {!showConsensus && (
          <input
            type="text"
            value={queueSearch}
            onChange={e => setQueueSearch(e.target.value)}
            placeholder="Search ID, city, state, coder…"
            style={{ padding: '0.25rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: '4px', fontSize: '0.875rem', width: '16rem' }}
          />
        )}
        {showConsensus && (
          <>
            <input
              type="text"
              value={consensusSearch}
              onChange={e => setConsensusSearch(e.target.value)}
              placeholder="Search by ID, pair, injury type…"
              style={{ padding: '0.25rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: '4px', fontSize: '0.875rem', width: '18rem' }}
            />
            {consensusSearch && (
              <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setConsensusSearch('')}>Clear</button>
            )}
            <span style={{ fontSize: '0.8rem', color: '#666' }}>
              {filteredConsensus.length} of {consensusTableRows.length} incidents
            </span>
          </>
        )}
        {filtersActive && !showConsensus && (
          <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => { setFilterPair('all'); setFilterCoder('all'); setFilterFlag('all'); setFilterStatus('all'); setQueueSearch('') }}>
            Clear filters
          </button>
        )}
      </div>

      {/* ── Load errors ── */}
      {Object.entries(coderData)
        .filter(([, d]) => d.status === 'error')
        .map(([name, d]) => (
          <div key={name} className="alert alert-error" style={{ margin: '0.25rem 1.25rem 0', flexShrink: 0 }}>
            Failed to load <strong>{name}</strong>: {d.error}
          </div>
        ))}

      {/* ── Resizable panel container ── */}
      <div ref={panelContainerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>

      {/* ── TOP PANEL: flagged rows table or consensus table ── */}
      <div style={{ flex: '0 0 auto', height: topPanelHeight, overflowY: 'auto' }}>
        {showConsensus ? (
          /* ── Consensus Records panel ── */
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Table */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filteredConsensus.length === 0 ? (
                <div style={{ padding: '1.5rem 1.25rem', color: '#666' }}>No consensus records yet{consensusSearch ? ' matching search' : ''}.</div>
              ) : (() => {
                const sortTh = (col, label) => (
                  <th style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }} onClick={() => handleConsensusSort(col)}>
                    {label} {consensusSortCol === col ? (consensusSortDir === 'asc' ? '▲' : '▼') : <span style={{ opacity: 0.35 }}>↕</span>}
                  </th>
                )
                return (
                  <table className="pi-review-table" style={{ width: '100%' }}>
                    <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
                      <tr>
                        <th>Pair</th>
                        {sortTh('incidentId', 'Incident ID')}
                        {sortTh('rows', 'Cases Confirmed')}
                        {sortTh('Cityorcounty', 'City/County')}
                        {sortTh('State', 'State')}
                        {sortTh('agencyname', 'Agency')}
                        {sortTh('Status2', 'Injury Type')}
                        {sortTh('agencytype', 'Agency Type')}
                        {sortTh('type_new', 'Shooting Type')}
                        {sortTh('ToRemove', 'Remove?')}
                        <th style={{ whiteSpace: 'nowrap' }}>Source</th>
                        {/* Source header kept for column alignment — value shown per expanded row */}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredConsensus.flatMap(({ incidentId, sampleLabel, rows, piSubmitted, allReconciled, reconciledMask }) => {
                        const rep        = rows[0]
                        const isExpanded = expandedConsensusIds.has(incidentId)
                        const isPartial  = !allReconciled  // some rows still need PI review
                        const mainRow = (
                          <tr
                            key={incidentId}
                            onClick={() => rows.length > 1 && toggleConsensusExpand(incidentId)}
                            style={{ cursor: rows.length > 1 ? 'pointer' : 'default' }}
                          >
                            <td style={{ whiteSpace: 'nowrap' }}>{sampleLabel}</td>
                            <td>
                              <code>{incidentId}</code>
                              {isPartial && (
                                <span
                                  title="Not all cases are reconciled — expand to see which require PI review"
                                  style={{ marginLeft: '0.4rem', color: '#c05621', fontWeight: 700, fontSize: '0.85rem' }}
                                >⚠</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'center', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {reconciledMask.filter(Boolean).length}/{rows.length}{rows.length > 1 ? ` ${isExpanded ? '▲' : '▼'}` : ''}
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>{rep.Cityorcounty || '—'}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{rep.State || '—'}</td>
                            <td style={{ whiteSpace: 'nowrap', color: rows.length > 1 ? '#aaa' : undefined }}>{rows.length > 1 ? '—' : (rep.agencyname || '—')}</td>
                            <td style={{ color: rows.length > 1 ? '#aaa' : undefined }}>{rows.length > 1 ? '—' : (rep.Status2 || '—')}</td>
                            <td style={{ color: rows.length > 1 ? '#aaa' : undefined }}>{rows.length > 1 ? '—' : (rep.agencytype || '—')}</td>
                            <td style={{ color: rows.length > 1 ? '#aaa' : undefined }}>{rows.length > 1 ? '—' : (rep.type_new || '—')}</td>
                            <td style={{ textAlign: 'center' }}>
                              {rows.length > 1 ? (
                                <span style={{ color: '#aaa' }}>—</span>
                              ) : (
                                <span style={{ color: rep.ToRemove === '1' ? '#c53030' : '#276749', fontWeight: 600 }}>
                                  {rep.ToRemove === '1' ? 'Yes' : 'No'}
                                </span>
                              )}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                              {!allReconciled
                                ? <span style={{ color: '#c05621', fontWeight: 600 }}>Partial</span>
                                : piSubmitted
                                  ? <span style={{ color: '#6b21a8', fontWeight: 600 }}>PI reviewed</span>
                                  : <span style={{ color: '#276749' }}>Auto-agreed</span>}
                            </td>
                          </tr>
                        )
                        const expandedRows = isExpanded ? rows.map((row, i) => {
                          const rowReconciled = reconciledMask[i]
                          const sourceLabel = !rowReconciled
                            ? <span style={{ color: '#c53030', fontWeight: 600 }}>Requires PI Review</span>
                            : piSubmitted
                              ? <span style={{ color: '#6b21a8', fontWeight: 600 }}>PI reviewed</span>
                              : <span style={{ color: '#276749' }}>Auto-agreed</span>
                          return (
                            <tr
                              key={`${incidentId}-${i}`}
                              style={{ background: rowReconciled ? '#fffbeb' : '#fff5f5', fontSize: '0.8rem' }}
                            >
                              <td style={{ color: '#888', paddingLeft: '1.5rem' }}>↳ Case {i + 1}</td>
                              <td><code style={{ fontSize: '0.75rem' }}>{row[config.idColumn]}</code></td>
                              <td style={{ textAlign: 'center', color: '#888' }}>Row {row.base_row_num || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>{row.Cityorcounty || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>{row.State || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>{row.agencyname || '—'}</td>
                              <td>{row.Status2 || '—'}</td>
                              <td>{row.agencytype || '—'}</td>
                              <td>{row.type_new || '—'}</td>
                              <td style={{ textAlign: 'center' }}>
                                <span style={{ color: row.ToRemove === '1' ? '#c53030' : '#276749' }}>
                                  {row.ToRemove === '1' ? 'Yes' : 'No'}
                                </span>
                              </td>
                              <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>{sourceLabel}</td>
                            </tr>
                          )
                        }) : []
                        return [mainRow, ...expandedRows]
                      })}
                    </tbody>
                  </table>
                )
              })()}
            </div>
          </div>
        ) : allLoaded && allFlaggedFiltered.length === 0 ? (
          <div style={{ padding: '1.5rem 1.25rem', color: '#666' }}>No flagged rows match the current filters.</div>
        ) : (
          <table className="pi-review-table" style={{ width: '100%' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
              <tr>
                <th>Pair</th>
                <th>Coder</th>
                <th
                  style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleSort('rowNum')}
                >
                  Row # {sortCol === 'rowNum' ? (sortDir === 'asc' ? '▲' : '▼') : <span style={{ opacity: 0.35 }}>↕</span>}
                </th>
                <th
                  style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleSort('incidentId')}
                >
                  Incident ID {sortCol === 'incidentId' ? (sortDir === 'asc' ? '▲' : '▼') : <span style={{ opacity: 0.35 }}>↕</span>}
                </th>
                <th style={{ whiteSpace: 'nowrap' }}>City/County</th>
                <th>State</th>
                <th>Flag(s)</th>
                <th>Notes</th>
                <th style={{ whiteSpace: 'nowrap' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {allFlaggedFiltered.map(({ coderName, info, row, rowIdx, flags, isCleared, isUncoded }) => {
                const isSelected = selected?.coderName === coderName && selected?.rowIdx === rowIdx
                const notes = row.Notes && row.Notes !== 'NA' && row.Notes !== PENDING ? row.Notes : null
                const notesTruncated = notes && notes.length > 80 ? notes.slice(0, 80) + '…' : notes

                return (
                  <tr
                    key={`${coderName}-${rowIdx}`}
                    onClick={() => { setSelected({ coderName, rowIdx }); setSaveOk(false); setSaveError(null) }}
                    style={{
                      cursor: 'pointer',
                      background: isSelected ? '#ebf4ff' : isUncoded ? '#fafafa' : undefined,
                      borderLeft: isSelected ? '3px solid #3182ce' : '3px solid transparent',
                      opacity: isUncoded ? 0.7 : 1,
                    }}
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>{info.label}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{coderName}</td>
                    <td style={{ textAlign: 'center' }}>{rowIdx + 1}</td>
                    <td><code>{row[config.idColumn]}</code></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{row.Cityorcounty || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{row.State || '—'}</td>
                    <td>
                      {isCleared ? (
                        <span style={{ color: '#276749', fontWeight: 600 }}>CLEARED</span>
                      ) : (
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                          {flags.map((flag, i) => (
                            <span
                              key={`${flag}-${i}`}
                              style={{
                                color: flag === 'Uncoded Case' ? '#718096'
                                     : flag.startsWith('≠ ')  ? '#6b21a8'
                                     : '#c53030',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {flag}{i < flags.length - 1 ? ',' : ''}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="pi-review-detail" style={{ maxWidth: '28rem' }}>
                      {notes ? (
                        <>
                          <span>{notesTruncated}</span>
                          {notes.length > 80 && (
                            <button
                              className="btn btn-secondary"
                              style={{ fontSize: '0.72rem', padding: '0.1rem 0.4rem', marginLeft: '0.4rem', verticalAlign: 'baseline' }}
                              onClick={e => { e.stopPropagation(); setNotesPopup({ coderName, rowIdx }) }}
                            >
                              ▼ expand
                            </button>
                          )}
                        </>
                      ) : (
                        <span style={{ color: '#aaa' }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {isUncoded ? (
                        <span style={{ color: '#a0aec0', fontSize: '0.8rem' }}>—</span>
                      ) : submittedIncidents.has(String(row[config.idColumn])) ? (
                        <span style={{ color: '#276749', fontWeight: 700, fontSize: '1.1rem' }} title="Confirmed">✓</span>
                      ) : reconciledIncidents.has(`${coderName}:${String(row[config.idColumn])}`) ? (
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', background: '#276749', borderColor: '#276749' }}
                          onClick={e => handleSubmit(coderName, row[config.idColumn], rowIdx, e)}
                        >
                          Submit
                        </button>
                      ) : (
                        <span style={{ color: '#c53030', fontWeight: 700, fontSize: '1.1rem' }} title="Conflicted">✗</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Drag divider ── */}
      <div
        onMouseDown={handleDividerMouseDown}
        style={{
          flex: '0 0 6px', height: '6px', cursor: 'row-resize',
          background: '#cbd5e0', borderTop: '1px solid #a0aec0', borderBottom: '1px solid #a0aec0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          userSelect: 'none',
        }}
        title="Drag to resize"
      >
        <div style={{ width: '2rem', height: '2px', background: '#718096', borderRadius: '1px' }} />
      </div>

      {/* ── BOTTOM PANEL — consensus comparison table ── */}

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, minWidth: 0 }}>
        {!selected || !selectedRow ? (
          <div style={{ padding: '2rem 1.25rem', color: '#888', fontStyle: 'italic' }}>
            Select a case above to review.
          </div>
        ) : (
          <div>
            {/* Context bar */}
            <div style={{ padding: '0.5rem 1.25rem', background: '#ebf4ff', borderBottom: '1px solid #bee3f8', display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.85rem', flexWrap: 'wrap' }}>
              <span><strong>{selectedInfo?.label}</strong></span>
              <span style={{ color: '#555' }}>Incident {selectedIncidentId} · Row {selectedRow.base_row_num || (selected.rowIdx + 1)}</span>
              <span style={{ color: '#777' }}>{selected.coderName.split(' ')[0]} vs {partnerName?.split(' ')[0]}</span>
              {saveError && <span style={{ color: '#c53030', fontSize: '0.78rem', marginLeft: 'auto' }}>{saveError}</span>}
              {lastAutoSaved && <span style={{ fontSize: '0.78rem', color: '#888', marginLeft: 'auto' }}>Autosaved {lastAutoSaved}</span>}
            </div>

            {hasPartner ? (() => {
              const nameA = selected.coderName.split(' ')[0]
              const nameB = partnerName?.split(' ')[0]

              const isPendingVal = val => !val || val === PENDING

              // Renders just the input/select for one coder's cell
              const renderInput = (col, side, val) => {
                const displayValue = isPendingVal(val) ? '' : val
                const pendingClass = isPendingVal(val) ? 'pending' : ''
                const fieldName = col.name

                // ── type_new: two-dropdown (primary + conditional secondary) ──
                if (fieldName === 'type_new') {
                  const { primary, secondary } = parseTypeNew(val)
                  const needsSec = TYPE_NEW_NEEDS_SECONDARY.has(primary)
                  return (
                    <div className="coded-field" style={{ flex: 1 }}>
                      <select value={isPendingVal(val) ? '' : primary} className={isPendingVal(val) ? 'pending' : ''}
                        onChange={e => handleDraftChange(side, fieldName, e.target.value || PENDING)}>
                        <option value="">— select —</option>
                        {TYPE_NEW_PRIMARY.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                      {needsSec && (
                        <select value={secondary || ''} className={!secondary ? 'pending' : ''}
                          style={{ marginTop: '0.25rem' }}
                          onChange={e => handleDraftChange(side, fieldName, e.target.value ? `${primary}; ${e.target.value}` : primary)}>
                          <option value="">— select subtype —</option>
                          {(TYPE_NEW_SECONDARY[primary] || []).map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      )}
                    </div>
                  )
                }

                // ── agencytype: Special (X) compound field ────────────────────
                if (fieldName === 'agencytype') {
                  const isSpecialVariant = val && val.startsWith('Special (') && val.endsWith(')')
                  const selectValue = isPendingVal(val) ? '' : isSpecialVariant ? 'Special (X)' : val
                  const specialDetail = isSpecialVariant ? val.slice(9, -1) : ''
                  return (
                    <div className="coded-field" style={{ flex: 1 }}>
                      <select value={selectValue} className={pendingClass}
                        onChange={e => {
                          const chosen = e.target.value
                          if (!chosen) handleDraftChange(side, fieldName, PENDING)
                          else if (chosen === 'Special (X)') handleDraftChange(side, fieldName, 'Special ()')
                          else handleDraftChange(side, fieldName, chosen)
                        }}>
                        <option value="">— select —</option>
                        {col.values.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                      {(selectValue === 'Special (X)' || isSpecialVariant) && (
                        <input type="text" value={specialDetail}
                          placeholder="e.g. University, School, Transit…"
                          style={{ marginTop: '0.25rem' }}
                          className={!specialDetail ? 'pending' : ''}
                          onChange={e => {
                            const detail = e.target.value.trim()
                            handleDraftChange(side, fieldName, detail ? `Special (${detail})` : 'Special ()')
                          }} />
                      )}
                    </div>
                  )
                }

                // ── rank: text + Unknown + N/A toggles ───────────────────────
                if (fieldName === 'rank') {
                  const isUnknown = val === 'Unknown'
                  const isNA      = val === 'N/A'
                  const isLocked  = isUnknown || isNA
                  const btnStyle  = active => ({
                    background: 'none', border: 'none', padding: 0,
                    fontSize: '0.72rem', cursor: 'pointer', textDecoration: 'underline',
                    color: active ? '#1a56db' : '#888',
                  })
                  return (
                    <div className="coded-field" style={{ flex: 1 }}>
                      <input type="text"
                        value={isUnknown ? 'Unknown' : isNA ? 'N/A' : displayValue}
                        placeholder="e.g. Officer, Detective…"
                        disabled={isLocked}
                        className={isPendingVal(val) && !isLocked ? 'pending' : ''}
                        style={isLocked ? { background: '#f5f5f5', color: '#888', fontStyle: 'italic' } : {}}
                        onChange={e => handleDraftChange(side, fieldName, e.target.value || PENDING)} />
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.15rem' }}>
                        <button type="button" style={btnStyle(isUnknown)}
                          onClick={() => handleDraftChange(side, fieldName, isUnknown ? PENDING : 'Unknown')}>
                          {isUnknown ? 'Clear Unknown' : 'Mark as Unknown'}
                        </button>
                        <button type="button" style={btnStyle(isNA)}
                          onClick={() => handleDraftChange(side, fieldName, isNA ? PENDING : 'N/A')}>
                          {isNA ? 'Clear N/A' : 'Mark as N/A'}
                        </button>
                      </div>
                    </div>
                  )
                }

                // ── agencyname: text + Unknown + N/A toggles ─────────────────
                if (fieldName === 'agencyname') {
                  const isUnknown = val === 'Unknown'
                  const isNA      = val === 'N/A'
                  const isLocked  = isUnknown || isNA
                  const btnStyle  = active => ({
                    background: 'none', border: 'none', padding: 0,
                    fontSize: '0.72rem', cursor: 'pointer', textDecoration: 'underline',
                    color: active ? '#1a56db' : '#888',
                  })
                  return (
                    <div className="coded-field" style={{ flex: 1 }}>
                      <input type="text"
                        value={isUnknown ? 'Unknown' : isNA ? 'N/A' : displayValue}
                        placeholder="e.g. Chicago Police Department"
                        disabled={isLocked}
                        className={isPendingVal(val) && !isLocked ? 'pending' : ''}
                        style={isLocked ? { background: '#f5f5f5', color: '#888', fontStyle: 'italic' } : {}}
                        onChange={e => handleDraftChange(side, fieldName, e.target.value || PENDING)} />
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.15rem' }}>
                        <button type="button" style={btnStyle(isUnknown)}
                          onClick={() => handleDraftChange(side, fieldName, isUnknown ? PENDING : 'Unknown')}>
                          {isUnknown ? 'Clear Unknown' : 'Mark as Unknown'}
                        </button>
                        <button type="button" style={btnStyle(isNA)}
                          onClick={() => handleDraftChange(side, fieldName, isNA ? PENDING : 'N/A')}>
                          {isNA ? 'Clear N/A' : 'Mark as N/A'}
                        </button>
                      </div>
                    </div>
                  )
                }

                // ── controlled_vocab: standard select ─────────────────────────
                if (col.type === 'controlled_vocab' && col.values) {
                  // Map 0/1 values to Yes/No labels; notactiveswornlocalstate is inverted
                  const isYesNo = col.values.includes('0') && col.values.includes('1')
                  const optionLabel = v => {
                    if (!isYesNo) return v
                    if (col.name === 'notactiveswornlocalstate') return v === '0' ? 'Yes' : v === '1' ? 'No' : v
                    return v === '0' ? 'No' : v === '1' ? 'Yes' : v
                  }
                  return (
                    <div className="coded-field" style={{ flex: 1 }}>
                      <select value={displayValue} className={pendingClass}
                        onChange={e => handleDraftChange(side, fieldName, e.target.value || PENDING)}>
                        <option value="">— select —</option>
                        {col.values.map(v => <option key={v} value={v}>{optionLabel(v)}</option>)}
                      </select>
                    </div>
                  )
                }
                return (
                  <div className="coded-field" style={{ flex: 1 }}>
                    <input type="text" value={displayValue} className={pendingClass}
                      onChange={e => handleDraftChange(side, fieldName, e.target.value || PENDING)} />
                  </div>
                )
              }

              const renderFieldRow = col => {
                const fieldName = col.name
                const isKey  = keyFieldNames.includes(fieldName)
                const valA   = draftA?.[fieldName] ?? ''
                const valB   = draftB?.[fieldName] ?? ''
                const agrees = valA === valB
                const bothBlank      = isPendingVal(valA) && isPendingVal(valB)
                const agreedUnknown  = agrees && valA === 'Unknown'
                const agreedBlankKey = agrees && isKey && isPendingVal(valA)
                const resolved = (agrees || bothBlank) && !agreedUnknown && !agreedBlankKey
                const disagreed = !resolved && !agreedUnknown && !agreedBlankKey

                return (
                  <tr key={fieldName} style={{ background: resolved ? undefined : '#fff5f5', borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '0.3rem 0.5rem', fontWeight: isKey ? 600 : 400, color: '#444', fontSize: '0.82rem', verticalAlign: 'middle' }}>
                      {fieldLabel(fieldName)}
                    </td>
                    {/* Coder A: input + "Copy Coder A to B" button on the right */}
                    <td style={{ padding: '0.2rem 0.4rem', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                        {renderInput(col, 'a', valA)}
                        <button className="btn btn-secondary"
                          style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap', flexShrink: 0,
                                   visibility: (disagreed && !isPendingVal(valA)) ? 'visible' : 'hidden' }}
                          onClick={() => handleDraftChange('b', fieldName, valA)}>
                          Copy Coder A to B
                        </button>
                      </div>
                    </td>
                    {/* Status */}
                    <td style={{ padding: '0.2rem 0.3rem', textAlign: 'center', verticalAlign: 'middle', fontSize: '0.72rem', whiteSpace: 'nowrap', width: '7%' }}>
                      {resolved       && <span style={{ color: '#276749' }}>✓ agree</span>}
                      {agreedUnknown  && <span style={{ color: '#c53030' }}>⚠ Unknown</span>}
                      {agreedBlankKey && <span style={{ color: '#c53030' }}>⚠ blank</span>}
                    </td>
                    {/* Coder B: "Copy Coder B to A" button on the left + input */}
                    <td style={{ padding: '0.2rem 0.4rem', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                        <button className="btn btn-secondary"
                          style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap', flexShrink: 0,
                                   visibility: (disagreed && !isPendingVal(valB)) ? 'visible' : 'hidden' }}
                          onClick={() => handleDraftChange('a', fieldName, valB)}>
                          Copy Coder B to A
                        </button>
                        {renderInput(col, 'b', valB)}
                      </div>
                    </td>
                  </tr>
                )
              }

              const bulkAdoptBar = (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.8rem', padding: '0.4rem 0' }}>
                  <span style={{ color: '#666' }}>Transpose All Coder Values:</span>
                  <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }}
                    onClick={() => {
                      if (!selected || !selectedRow || !partnerRow) return
                      const key = `${selected.coderName}:${selected.rowIdx}`
                      setDraftHistory(prev => [...prev, consensusDraft])
                      const base = currentDraft?.a ?? selectedRow
                      setConsensusDraft(prev => ({ ...prev, [key]: { a: { ...base }, b: { ...base } } }))
                    }}>
                    Copy Coder A to B
                  </button>
                  <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }}
                    onClick={() => {
                      if (!selected || !selectedRow || !partnerRow) return
                      const key = `${selected.coderName}:${selected.rowIdx}`
                      setDraftHistory(prev => [...prev, consensusDraft])
                      const base = currentDraft?.b ?? partnerRow
                      setConsensusDraft(prev => ({ ...prev, [key]: { a: { ...base }, b: { ...base } } }))
                    }}>
                    Copy Coder B to A
                  </button>
                </div>
              )

              // Field (13%) | CoderA (40%) | Status (7%) | CoderB (40%)
              const tableColgroup = (
                <colgroup>
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '40%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '40%' }} />
                </colgroup>
              )

              const tableHead = (
                <thead>
                  <tr style={{ background: '#f1f5f9' }}>
                    <th style={{ padding: '0.35rem 0.5rem', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid #e2e8f0' }}>Field</th>
                    <th style={{ padding: '0.35rem 0.5rem', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid #e2e8f0' }}>{nameA} <span style={{ fontWeight: 400, color: '#666' }}>(A)</span></th>
                    <th style={{ borderBottom: '2px solid #e2e8f0' }} />
                    <th style={{ padding: '0.35rem 0.5rem', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid #e2e8f0' }}>{nameB} <span style={{ fontWeight: 400, color: '#666' }}>(B)</span></th>
                  </tr>
                </thead>
              )

              // blueonblue is in supplementaryColumns; split there so Notes/CaseSummary
              // appear after blueonblue but before Duplicate/record_added/etc.
              const bbIdx = config.supplementaryColumns.findIndex(c => c.name === 'blueonblue')
              const suppColsTop    = bbIdx >= 0 ? config.supplementaryColumns.slice(0, bbIdx + 1) : config.supplementaryColumns
              const suppColsBottom = bbIdx >= 0 ? config.supplementaryColumns.slice(bbIdx + 1) : []

              return (
                <div style={{ padding: '0.75rem 1.25rem', minWidth: 0, overflow: 'hidden' }}>

                  {/* Bulk adopt — top, above column headers */}
                  {bulkAdoptBar}

                  {/* Key columns + supplementary top (notactiveswornlocalstate through blueonblue) */}
                  <table style={{ width: '100%', fontSize: '0.83rem', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    {tableColgroup}
                    {tableHead}
                    <tbody>
                      {config.keyColumns.map(renderFieldRow)}
                      {suppColsTop.map(renderFieldRow)}
                    </tbody>
                  </table>

                  {/* Case Summary and Notes — below Blue on Blue, above Duplicate/record_added */}
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {['CaseSummary', 'Notes'].map(fieldName => {
                      const label = fieldName === 'CaseSummary' ? 'Case Summary' : 'Notes'
                      const valA  = draftA?.[fieldName] ?? ''
                      const valB  = draftB?.[fieldName] ?? ''
                      return (
                        <div key={fieldName}>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#444', marginBottom: '0.25rem' }}>{label}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                            {/* Coder A: textarea + "Copy Coder A to B" button below */}
                            <div>
                              <div style={{ fontSize: '0.72rem', color: '#666', marginBottom: '0.15rem' }}>{nameA} (A)</div>
                              <div className="coded-field">
                                <textarea value={isPendingVal(valA) ? '' : valA} rows={4}
                                  onChange={e => handleDraftChange('a', fieldName, e.target.value || PENDING)} />
                              </div>
                              <button className="btn btn-secondary"
                                style={{ fontSize: '0.68rem', padding: '0.1rem 0.35rem', marginTop: '0.25rem', whiteSpace: 'nowrap' }}
                                onClick={() => handleDraftChange('b', fieldName, isPendingVal(valA) ? PENDING : valA)}>
                                Copy Coder A to B
                              </button>
                            </div>
                            {/* Coder B: "Copy Coder B to A" button above + textarea */}
                            <div>
                              <div style={{ fontSize: '0.72rem', color: '#666', marginBottom: '0.15rem' }}>{nameB} (B)</div>
                              <div className="coded-field">
                                <textarea value={isPendingVal(valB) ? '' : valB} rows={4}
                                  onChange={e => handleDraftChange('b', fieldName, e.target.value || PENDING)} />
                              </div>
                              <button className="btn btn-secondary"
                                style={{ fontSize: '0.68rem', padding: '0.1rem 0.35rem', marginTop: '0.25rem', whiteSpace: 'nowrap' }}
                                onClick={() => handleDraftChange('a', fieldName, isPendingVal(valB) ? PENDING : valB)}>
                                Copy Coder B to A
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Bulk adopt — below notes */}
                  <div style={{ marginTop: '0.5rem', marginBottom: '0.25rem' }}>
                    {bulkAdoptBar}
                  </div>

                  {/* Supplementary bottom (Duplicate, record_added, etc.) */}
                  {suppColsBottom.length > 0 && (
                    <table style={{ width: '100%', fontSize: '0.83rem', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                      {tableColgroup}
                      <tbody>
                        {suppColsBottom.map(renderFieldRow)}
                      </tbody>
                    </table>
                  )}

                </div>
              )
            })() : (
              <div style={{ padding: '1.5rem', color: '#888', fontStyle: 'italic' }}>
                No partner coder data available for this sample.
              </div>
            )}
          </div>
        )}
      </div>

      </div>{/* end resizable panel container */}

    </div>
  )
}
