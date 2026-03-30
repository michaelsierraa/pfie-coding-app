import { Fragment, useMemo, useState } from 'react'
import { isRowComplete, isRowFlaggedForPI } from '../hooks/useSampleData.js'

const PENDING = 'PENDING'

const INTEGRITY_FIELDS = [
  'Duplicate', 'duplicate_type', 'duplicate_of',
  'record_added', 'incident_id_changed', 'incident_change_type', 'reassign_to_id', 'original_id',
]

function rowNeedsExplanation(row) {
  const hasFlag = INTEGRITY_FIELDS.some(f => {
    const v = row[f]
    return v && v !== '0' && v !== 'NA' && v !== PENDING && v !== ''
  })
  const hasNotes =
    row.CaseSummary &&
    row.CaseSummary !== 'NA' &&
    row.CaseSummary !== PENDING &&
    row.CaseSummary.trim() !== ''
  return hasFlag && !hasNotes
}

function groupStatus(group) {
  if (group.rows.some(rowNeedsExplanation)) return 'warn'
  if (group.rows.some(isRowFlaggedForPI)) return 'flag'
  if (group.rows.every(r => r.record_added === '1' || isRowComplete(r))) return 'complete'
  return 'incomplete'
}

const STATUS = {
  complete:   { label: '✓',  cls: 'ov-s-complete',   title: 'Complete' },
  warn:       { label: '!',  cls: 'ov-s-warn',        title: 'Needs explanation' },
  flag:       { label: 'PI', cls: 'ov-s-flag',        title: 'Flagged for PI review' },
  incomplete: { label: '✗',  cls: 'ov-s-incomplete',  title: 'Incomplete' },
}

function sortGroups(enriched, key, dir) {
  if (!key) return enriched
  return [...enriched].sort((a, b) => {
    let av = '', bv = ''
    if (key === 'id')    { av = a.id;                             bv = b.id }
    if (key === 'date')  { av = a.rows[0]?.Date || '';            bv = b.rows[0]?.Date || '' }
    if (key === 'city')  { av = a.rows[0]?.Cityorcounty || '';    bv = b.rows[0]?.Cityorcounty || '' }
    if (key === 'state') { av = a.rows[0]?.State || '';           bv = b.rows[0]?.State || '' }
    // Empty values sort last regardless of direction
    if (!av && bv) return 1
    if (av && !bv) return -1
    const cmp = av.localeCompare(bv)
    return dir === 'asc' ? cmp : -cmp
  })
}

export default function IncidentOverview({ groups, currentIdx, onNavigate, onClose }) {
  const [expanded,        setExpanded]        = useState(new Set())
  const [sortKey,         setSortKey]         = useState(null)   // 'id' | 'date' | 'city' | 'state'
  const [sortDir,         setSortDir]         = useState('asc')  // 'asc' | 'desc'
  const [selectedStates,  setSelectedStates]  = useState(new Set())
  const [stateFilterOpen, setStateFilterOpen] = useState(false)

  // Unique sorted states from all incidents
  const allStates = useMemo(() => {
    const states = new Set()
    groups.forEach(g => {
      const s = g.rows[0]?.State
      if (s && s !== 'NA' && s !== PENDING && s.trim()) states.add(s.trim())
    })
    return [...states].sort()
  }, [groups])

  // Enrich with original index, then filter and sort
  const displayGroups = useMemo(() => {
    const enriched = groups.map((g, i) => ({ ...g, originalIdx: i }))
    const filtered = selectedStates.size === 0
      ? enriched
      : enriched.filter(g => {
          const s = (g.rows[0]?.State || '').trim()
          return selectedStates.has(s)
        })
    return sortGroups(filtered, sortKey, sortDir)
  }, [groups, selectedStates, sortKey, sortDir])

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleState(state) {
    setSelectedStates(prev => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }

  function handleNavigate(originalIdx) {
    onNavigate(originalIdx)
    onClose()
  }

  function SortIcon({ col }) {
    if (sortKey !== col) return <span className="ov-sort-icon">⇅</span>
    return <span className="ov-sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function ColHeader({ col, label }) {
    return (
      <button
        className={`ov-sort-btn${sortKey === col ? ' ov-sort-btn-active' : ''}`}
        onClick={() => handleSort(col)}
      >
        {label} <SortIcon col={col} />
      </button>
    )
  }

  const stateFilterLabel = selectedStates.size === 0
    ? 'All States'
    : selectedStates.size === 1
      ? [...selectedStates][0]
      : `${selectedStates.size} States`

  const visibleCount = displayGroups.length
  const totalCount = groups.length

  return (
    <>
      <div className="ov-backdrop" onClick={onClose} />
      <div className="ov-drawer" role="dialog" aria-label="Incident overview">

        {/* Header */}
        <div className="ov-header">
          <span className="ov-title">
            Incidents{' '}
            <span className="ov-count">
              {visibleCount < totalCount ? `${visibleCount} / ${totalCount}` : totalCount}
            </span>
          </span>
          <button className="ov-close" onClick={onClose} aria-label="Close overview">✕</button>
        </div>

        {/* Filter bar */}
        <div className="ov-filterbar">
          <div className="ov-state-filter">
            <button
              className={`ov-filter-btn${selectedStates.size > 0 ? ' ov-filter-btn-active' : ''}`}
              onClick={() => setStateFilterOpen(o => !o)}
            >
              {stateFilterLabel} ▾
            </button>
            {stateFilterOpen && (
              <>
                <div className="ov-state-backdrop" onClick={() => setStateFilterOpen(false)} />
                <div className="ov-state-dropdown">
                  <div className="ov-state-actions">
                    <button onClick={() => setSelectedStates(new Set())}>Clear</button>
                    <button onClick={() => setSelectedStates(new Set(allStates))}>Select all</button>
                  </div>
                  {allStates.map(state => (
                    <label key={state} className="ov-state-option">
                      <input
                        type="checkbox"
                        checked={selectedStates.has(state)}
                        onChange={() => toggleState(state)}
                      />
                      {state}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {sortKey && (
            <button
              className="ov-clear-sort"
              onClick={() => { setSortKey(null); setSortDir('asc') }}
              title="Clear sort"
            >
              Clear sort
            </button>
          )}
        </div>

        {/* Table */}
        <div className="ov-body">
          <table className="ov-table">
            <thead>
              <tr>
                <th className="ov-th-expand" />
                <th><ColHeader col="id"    label="Incident ID" /></th>
                <th><ColHeader col="date"  label="Date" /></th>
                <th><ColHeader col="city"  label="City" /></th>
                <th><ColHeader col="state" label="State" /></th>
                <th className="ov-th-cases">Cases</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {displayGroups.length === 0 && (
                <tr>
                  <td colSpan={7} className="ov-empty">No incidents match the current filter.</td>
                </tr>
              )}
              {displayGroups.map(group => {
                const isMulti = group.rows.length > 1
                const isOpen = expanded.has(group.id)
                const isCurrent = group.originalIdx === currentIdx
                const firstRow = group.rows[0] || {}
                const sourceCount = group.rows.filter(r => r.record_added !== '1').length
                const addedCount = group.rows.length - sourceCount
                const s = STATUS[groupStatus(group)]

                return (
                  <Fragment key={group.id}>
                    <tr className={`ov-row${isCurrent ? ' ov-row-current' : ''}`}>
                      <td className="ov-expand-cell">
                        {isMulti && (
                          <button
                            className="ov-expand-btn"
                            onClick={() => toggleExpand(group.id)}
                            aria-label={isOpen ? 'Collapse cases' : 'Expand cases'}
                          >
                            {isOpen ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                      <td>
                        <button className="ov-id-btn" onClick={() => handleNavigate(group.originalIdx)}>
                          {group.id}
                        </button>
                      </td>
                      <td className="ov-cell">{firstRow.Date || '—'}</td>
                      <td className="ov-cell">{firstRow.Cityorcounty || '—'}</td>
                      <td className="ov-cell">{firstRow.State || '—'}</td>
                      <td className="ov-cell">
                        {sourceCount}{addedCount > 0 ? ` +${addedCount}` : ''}
                      </td>
                      <td className="ov-status-cell">
                        <span className={`ov-status ${s.cls}`} title={s.title}>{s.label}</span>
                      </td>
                    </tr>

                    {isOpen && group.rows.map((row, caseIdx) => {
                      const done = row.record_added === '1' || isRowComplete(row)
                      const name =
                        row.record_added === '1'
                          ? 'Added case'
                          : (row.Name && row.Name !== 'NA' && row.Name !== PENDING)
                            ? row.Name
                            : 'Unknown'
                      return (
                        <tr key={`${group.id}-${caseIdx}`} className="ov-case-row">
                          <td />
                          <td className="ov-case-label" colSpan={3}>
                            {caseIdx + 1}. {name}
                          </td>
                          <td className="ov-cell">
                            {row.Gender && row.Gender !== 'NA' ? row.Gender : '—'}
                          </td>
                          <td className="ov-cell">
                            {row.Status && row.Status !== 'NA' ? row.Status : '—'}
                          </td>
                          <td className="ov-status-cell">
                            <span className={`ov-status ${done ? 'ov-s-complete' : 'ov-s-incomplete'}`}>
                              {done ? '✓' : '✗'}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
