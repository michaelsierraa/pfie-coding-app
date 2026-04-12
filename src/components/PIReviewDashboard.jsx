import { useEffect, useState } from 'react'
import { parseCSV } from '../lib/csv.js'
import { isRowFlaggedForPI, UNKNOWN_REVIEW_FIELDS } from '../hooks/useSampleData.js'

const WORKER_URL = import.meta.env.VITE_WORKER_URL
const PENDING = 'PENDING'

function flagsForRow(row) {
  const flags = []
  if (row.record_added === '1') flags.push('Added')
  if (row.incident_id_changed === '1') flags.push('ID Changed')
  const unknownCount = UNKNOWN_REVIEW_FIELDS.filter(f => row[f] === 'Unknown').length
  if (unknownCount > 0) flags.push(`Unknown (${unknownCount})`)
  return flags
}

/**
 * PIReviewDashboard — loads all coder files in parallel and displays
 * a filterable table of every row flagged for PI review.
 *
 * Props:
 *   config      — parsed config object
 *   token       — GitHub OAuth token (PI)
 *   onBack      — called when PI clicks "← Back" (returns to PIDashboard)
 *   onViewCoder — called with coderName when PI clicks "View →" on a row
 */
export default function PIReviewDashboard({ config, token, onBack, onViewCoder }) {
  // coderData: { [coderName]: { sampleId, role, label, flaggedRows, status, error } }
  const [coderData, setCoderData] = useState({})

  const [filterPair, setFilterPair]   = useState('all')
  const [filterCoder, setFilterCoder] = useState('all')
  const [filterFlag, setFilterFlag]   = useState('all')

  useEffect(() => {
    if (!config || !token) return

    const initial = {}
    for (const sample of config.samples) {
      for (const [role, nameKey] of [['a', 'coder_a'], ['b', 'coder_b']]) {
        const name = sample[nameKey]
        if (!name) continue
        initial[name] = {
          sampleId: sample.id,
          role,
          label: sample.label || `Sample ${sample.id}`,
          flaggedRows: [],
          status: 'loading',
          error: null,
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
          const rows = parseCSV(text)
          const flaggedRows = rows
            .map((row, rowIdx) => ({ row, rowIdx }))
            .filter(({ row }) => isRowFlaggedForPI(row))
          setCoderData(prev => ({
            ...prev,
            [name]: { ...prev[name], flaggedRows, status: 'loaded' },
          }))
        })
        .catch(err => {
          setCoderData(prev => ({
            ...prev,
            [name]: { ...prev[name], status: 'error', error: err.message },
          }))
        })
    }
  }, [config, token])

  // Build filtered flat list
  const allFlagged = []
  for (const [coderName, info] of Object.entries(coderData)) {
    if (info.status !== 'loaded') continue
    if (filterPair !== 'all' && String(info.sampleId) !== filterPair) continue
    if (filterCoder !== 'all' && coderName !== filterCoder) continue
    for (const { row, rowIdx } of info.flaggedRows) {
      const flags = flagsForRow(row)
      if (filterFlag === 'record_added'       && row.record_added !== '1') continue
      if (filterFlag === 'incident_id_changed' && row.incident_id_changed !== '1') continue
      if (filterFlag === 'unknown'             && !UNKNOWN_REVIEW_FIELDS.some(f => row[f] === 'Unknown')) continue
      allFlagged.push({ coderName, info, row, rowIdx, flags })
    }
  }
  allFlagged.sort((a, b) =>
    a.info.sampleId - b.info.sampleId ||
    a.coderName.localeCompare(b.coderName) ||
    a.rowIdx - b.rowIdx
  )

  const totalCoders  = Object.keys(coderData).length
  const loadedCount  = Object.values(coderData).filter(d => d.status === 'loaded').length
  const errorCount   = Object.values(coderData).filter(d => d.status === 'error').length
  const allLoaded    = loadedCount + errorCount === totalCoders && totalCoders > 0

  const pairs      = config.samples.map(s => ({ id: s.id, label: s.label || `Sample ${s.id}` }))
  const coderNames = Object.keys(coderData).sort()
  const filtersActive = filterPair !== 'all' || filterCoder !== 'all' || filterFlag !== 'all'

  return (
    <div className="app-shell">

      {/* ── Sticky header ── */}
      <div className="table-header">
        <div>
          <h2>PI Review Queue</h2>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>
            {allLoaded
              ? `${allFlagged.length} flagged row${allFlagged.length !== 1 ? 's' : ''} across ${loadedCount} coder${loadedCount !== 1 ? 's' : ''}`
              : `Loading… ${loadedCount} / ${totalCoders} coders`}
          </div>
        </div>
        <div className="table-actions">
          <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        </div>
        <div className="header-progress-bar">
          <div
            className="header-progress-fill"
            style={{ width: totalCoders > 0 ? `${Math.round((loadedCount / totalCoders) * 100)}%` : '0%' }}
          />
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div style={{
        display: 'flex', gap: '1.25rem', padding: '0.75rem 1.25rem',
        background: '#f8f9fa', borderBottom: '1px solid #e2e8f0',
        flexWrap: 'wrap', alignItems: 'center',
      }}>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
          Flag type
          <select value={filterFlag} onChange={e => setFilterFlag(e.target.value)}>
            <option value="all">All flags</option>
            <option value="record_added">Added row</option>
            <option value="incident_id_changed">ID changed</option>
            <option value="unknown">Unknown field</option>
          </select>
        </label>
        {filtersActive && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.8rem' }}
            onClick={() => { setFilterPair('all'); setFilterCoder('all'); setFilterFlag('all') }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Load errors ── */}
      {Object.entries(coderData)
        .filter(([, d]) => d.status === 'error')
        .map(([name, d]) => (
          <div key={name} className="alert alert-error" style={{ margin: '0.5rem 1.25rem 0' }}>
            Failed to load <strong>{name}</strong>: {d.error}
          </div>
        ))}

      {/* ── Table or empty state ── */}
      {allLoaded && allFlagged.length === 0 ? (
        <div style={{ padding: '2rem 1.25rem', color: '#666' }}>
          No flagged rows match the current filters.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', padding: '0.75rem 1.25rem' }}>
          <table className="pi-review-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Coder</th>
                <th>Row</th>
                <th>IncidentID</th>
                <th>Date</th>
                <th>Flag(s)</th>
                <th>Status2</th>
                <th>type_new</th>
                <th>Case Summary</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {allFlagged.map(({ coderName, info, row, rowIdx, flags }, i) => {
                const summary = (row.CaseSummary && row.CaseSummary !== 'NA' && row.CaseSummary !== PENDING)
                  ? (row.CaseSummary.length > 120 ? row.CaseSummary.slice(0, 120) + '…' : row.CaseSummary)
                  : '—'
                const status2  = row.Status2  && row.Status2  !== PENDING ? row.Status2  : '—'
                const typeNew  = row.type_new && row.type_new !== PENDING ? row.type_new : '—'
                return (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{info.label}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{coderName}</td>
                    <td>{rowIdx + 1}</td>
                    <td><code>{row[config.idColumn]}</code></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{row.Date || '—'}</td>
                    <td>{flags.join(', ')}</td>
                    <td>{status2}</td>
                    <td>{typeNew}</td>
                    <td className="pi-review-detail">{summary}</td>
                    <td>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                        onClick={() => onViewCoder(coderName)}
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  )
}
