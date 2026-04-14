import { useState, useRef, useLayoutEffect, useMemo } from 'react'
import { isRowComplete } from '../hooks/useSampleData.js'

const PENDING = 'PENDING'

// ── Tooltip content (sourced from GVA_Project_Onboarding) ────────────────────

const COLUMN_INFO = {
  Status2: `Was the officer fatally or non-fatally wounded by the shooting?\n\nFatal — officer died from gunshot wounds. Use this even if death was initially uncertain but later confirmed.\nNon-fatal — officer was wounded but survived.\nNo injury — the person was present but not physically injured (e.g., a bullet struck their vest or equipment with no bodily harm). Use this when the officer was not physically wounded.\nUnknown — outcome cannot be confirmed from available sources. Selecting this flags the case for PI review.\n\nEdge cases:\n• Shrapnel / fragmented bullet: if an officer was struck by shrapnel from a gunshot, code as wounded (Fatal or Non-fatal based on outcome).\n• Vehicle strikes / ramming: these are NOT shootings — these cases should not be in the dataset.\n• Armor / equipment strikes: if a bullet struck a vest or equipment and the officer was not physically wounded, code No injury.\n• If initially reported injured but later died from those wounds, code Fatal.`,

  agencytype: `What kind of law enforcement agency does this officer work for?\n\n• Local — city or county police department\n• Sheriff — sheriff's office\n• State — state police or highway patrol\n• Special — a special-jurisdiction agency: transit police, campus/university police, tribal police, park police, housing authority, airport, etc. Select Special and specify the type in the box.\n• Federal — FBI, DEA, ATF, U.S. Marshals, etc.\n• Corrections — jail or prison staff.\n• None — the injured person has no law enforcement agency affiliation. Usually means Active/Sworn = No (i.e., they are not an officer).\n• Unknown — only if you genuinely cannot determine it after checking all sources.`,

  agencyname: `Full official name of the agency (e.g., "Chicago Police Department", "Cook County Sheriff's Office", "Illinois State Police").\n\nUse N/A if the person has no agency — this usually means Active/Sworn = No (they are not an officer).\nUse Unknown if the person is an officer but you can't confirm the agency name after checking sources.`,

  type_new: `Classify the shooting in two steps.\n\nStep 1 — Who fired the shot?\n• Suspect-inflicted — a suspect shot the officer (no second step needed)\n• Self-inflicted — the officer shot themselves\n• Blue-on-blue — another on-duty officer shot this officer\n• None — there was no shooting of an officer. Use this when a person was injured another way (e.g., vehicle strike, stabbing) — this is not a qualifying shooting event.\n• Unknown — cannot determine; flags for PI review\n\nStep 2 — subtype (required for Self-inflicted and Blue-on-blue)\nSelf-inflicted: Accidental · Intentional/Suicide · Unknown\nBlue-on-blue: Accidental · Suspect-inflicted · Unknown`,

  notactiveswornlocalstate: `Is this officer currently active duty and sworn — meaning they hold full arrest powers and are not retired?\n\n• Yes — active duty, sworn officer with full arrest powers\n• No — not sworn, or retired. Examples: retired officers who intervened in an incident, unsworn police employees (e.g., crime scene technicians, civilian dispatchers)\n• Unknown — can't confirm from sources; flags for PI review`,

  rank: `Officer's rank as reported in the sources.\n\nCommon values: Officer, Deputy, Sergeant, Detective, Trooper, Corporal, Lieutenant, Captain, Sheriff, Police Chief, Marshal.\n\nUse N/A if the person has no rank — this usually means Active/Sworn = No (they are not an officer).\nUse Unknown if the person is an officer but their rank isn't mentioned in any source.`,

  offduty: `Was the officer shot while off the clock?\n\nOff-duty means the officer was still employed but not working at the time of the incident. Do not use this for retired officers — use Active, Sworn instead.\n\nMark Unknown if you can't confirm from sources — flags for PI review.`,

  training: `Was the officer shot during a training exercise? Includes live-fire practice, firearms qualification, academy training, or simulated scenarios.\n\nMark Unknown if you can't determine this from sources — flags for PI review.`,

  blueonblue: `Was the officer shot by another on-duty police officer? This most commonly happens in crossfire situations.\n\nMark Unknown if you can't determine this from sources — flags for PI review.`,

  ToRemove: `Should this case be excluded from the analytic sample?\n\nThis field is set automatically based on other coding decisions — you generally only need to override it manually if there's a reason not captured by the other fields.\n\nFor duplicate rows: mark Yes on the duplicate only, not the original.`,

  Duplicate: `Mark Yes if this specific officer row is a duplicate — i.e., the same officer already appears in another row in the dataset.\n\nUse the selector to identify the original row. Mark the duplicate, not the original.\n\nIf the entire incident has the wrong ID, use "Incorrect Incident ID?" instead.`,

  duplicate_of: `The original row or incident that this case duplicates. Select from the searchable list — it must exist in the current dataset.`,

  add_case: `Add a new case under this Incident ID if the original GVA data is missing an officer who was shot during this same incident.\n\nAdded cases are appended to the end of the dataset and flagged for PI review before being integrated.`,

  record_added: `Marks a row that was manually added during coding (not in the original GVA data pull). Set automatically when you click "Add Case Under This Incident ID" — leave it as-is.`,

  incident_id_changed: `TODO: clarify this field description with PI.\n\nUse this when the case does not belong under the current Incident ID. Two scenarios:\n1. Reassign to existing — the case belongs to a different incident already in the dataset.\n2. New Incident ID — the case is a real event but has no corresponding incident in the data yet; the PI will assign a new ID.\n\nFlagged for PI review in both cases.`,

  original_id: `If the incident ID was changed, enter the original GVA-assigned ID here. Appears when Incident ID Changed = Yes.`,

  CaseSummary: `A brief narrative summary of the incident.\n\nFormat: [Agency type] [Rank] [fatally/non-fatally] shot [wound location/body part] [context].\nExample: "Local Officer non-fatally shot in the leg while responding to a domestic disturbance."\n\nInclude:\n• Wound location (only what sources explicitly state)\n• For multi-officer incidents: briefly reference the other officers\n• Any explanation for data changes (duplicate, added case, ID change)\n• "Unclear — flagged for PI review" when you're uncertain about a coding decision`,
}

// ── Display name overrides (column name → UI label) ───────────────────────────

const DISPLAY_NAMES = {
  Status2:                  'Injury Type',
  agencytype:               'Agency Type',
  type_new:                 'Shooting Type',
  ToRemove:                 'Remove Case',
  notactiveswornlocalstate: 'Active, Sworn',
  agencyname:               'Agency Name',
  rank:                     'Rank',
  offduty:                  'Off-duty',
  training:                 'Training',
  blueonblue:               'Blue-on-Blue',
  Duplicate:                'Duplicate',
  duplicate_of:             'Duplicate Of',
  record_added:             'Record Added',
  incident_id_changed:      'Incorrect Incident ID?',
  original_id:              'Original ID',
}

function displayName(colName) {
  return DISPLAY_NAMES[colName] || colName
}

// ── Display value overrides: any 0/1 field renders as Yes/No ─────────────────

const YES_NO_FIELDS = new Set([
  'ToRemove', 'offduty', 'training',
  'blueonblue', 'Duplicate', 'record_added', 'incident_id_changed',
])

const YES_NO_MAP = { '1': 'Yes', '0': 'No' }

// notactiveswornlocalstate is displayed as "Active, Sworn" (Yes = eligible).
// The underlying value is inverted: 0 = eligible (Yes), 1 = not eligible (No).
const ACTIVE_SWORN_MAP = { '0': 'Yes', '1': 'No', 'Unknown': 'Unknown' }

function getValueMap(colName) {
  if (colName === 'notactiveswornlocalstate') return ACTIVE_SWORN_MAP
  return YES_NO_FIELDS.has(colName) ? YES_NO_MAP : null
}

// ── Visible field display order ───────────────────────────────────────────────
// Defines layout order independently of config array order.
// ToRemove is last; agencyname follows agencytype; integrity fields excluded.

const MAIN_FIELD_ORDER = [
  'Status2', 'agencytype', 'agencyname', 'type_new',
  'notactiveswornlocalstate', 'rank', 'offduty', 'training', 'blueonblue',
  'ToRemove',
]

// ── Tooltip component ─────────────────────────────────────────────────────────

function InfoTooltip({ column }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState({ x: false, y: false })
  const popupRef = useRef(null)
  const measuredRef = useRef(false)
  const text = COLUMN_INFO[column]

  // Measure popup position after it renders; flip toward viewport if it overflows.
  // useLayoutEffect runs before the browser paints, so there's no visible flicker.
  useLayoutEffect(() => {
    if (!open) {
      measuredRef.current = false
      setFlip({ x: false, y: false })
      return
    }
    if (measuredRef.current || !popupRef.current) return
    measuredRef.current = true
    const rect = popupRef.current.getBoundingClientRect()
    setFlip({
      x: rect.right > window.innerWidth - 8,
      y: rect.bottom > window.innerHeight - 8,
    })
  }, [open])

  if (!text) return null

  const popupStyle = {}
  if (flip.x) { popupStyle.left = 'auto'; popupStyle.right = '0' }
  if (flip.y) { popupStyle.top = 'auto'; popupStyle.bottom = 'calc(100% + 4px)' }

  return (
    <span
      className="info-tooltip-wrapper"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-btn"
        onClick={() => setOpen(o => !o)}
        aria-label={`Info for ${column}`}
      >
        ⓘ
      </button>
      {open && (
        <div className="info-popup" ref={popupRef} role="tooltip" style={popupStyle}>
          <pre className="info-popup-text">{text}</pre>
        </div>
      )}
    </span>
  )
}

// ── URL sanitizer ─────────────────────────────────────────────────────────────

function sanitizeUrl(raw) {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') return trimmed
    return null
  } catch {
    return null
  }
}

// ── Source display fields (Incidentcharacteristics intentionally excluded) ────

const SOURCE_DISPLAY_FIELDS = [
  { name: 'IncidentID',   label: 'Incident ID' },
  { name: 'Date',         label: 'Date' },
  { name: 'State',        label: 'State' },
  { name: 'Cityorcounty', label: 'City / County' },
  { name: 'Name',         label: 'Name' },
  { name: 'Gender',       label: 'Gender' },
  { name: 'Age',          label: 'Age' },
  { name: 'Status',       label: 'Status (GVA)' },
  { name: 'Type',         label: 'Type (GVA)' },
]

// Primary flags that require Case Summary explanation when set to '1'
const INTEGRITY_FIELDS = ['Duplicate', 'record_added', 'incident_id_changed']

// ── Shooting Type (type_new) two-dropdown structure ───────────────────────────
const TYPE_NEW_PRIMARY   = ['Suspect-inflicted', 'Self-inflicted', 'Blue-on-blue', 'None', 'Unknown']
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

// ── ToRemove auto-logic ───────────────────────────────────────────────────────

const TO_REMOVE_TRIGGERS = new Set(['notactiveswornlocalstate', 'offduty', 'training', 'blueonblue', 'type_new'])

function computeShouldRemove(rowState) {
  if (rowState.notactiveswornlocalstate === '1') return true
  if (rowState.offduty === '1') return true
  if (rowState.training === '1') return true
  if (rowState.blueonblue === '1') return true
  const tn = rowState.type_new
  if (tn && tn !== PENDING && !tn.startsWith('Suspect-inflicted')) return true
  return false
}

function getActiveTriggerLabels(rowState) {
  const labels = []
  if (rowState.notactiveswornlocalstate === '1') labels.push(`${DISPLAY_NAMES.notactiveswornlocalstate} = No`)
  if (rowState.offduty === '1') labels.push(`${DISPLAY_NAMES.offduty} = Yes`)
  if (rowState.training === '1') labels.push(`${DISPLAY_NAMES.training} = Yes`)
  if (rowState.blueonblue === '1') labels.push(`${DISPLAY_NAMES.blueonblue} = Yes`)
  const tn = rowState.type_new
  if (tn && tn !== PENDING && !tn.startsWith('Suspect-inflicted')) {
    labels.push(`${DISPLAY_NAMES.type_new} = ${tn}`)
  }
  return labels
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CodingRow({ row, config, onChange, rowIndex, dataIndex, allRows, isAddedRow, onAddCase, onDeleteCase, onConfirmCase, isConfirmed, flaggedFields = new Set(), onSave }) {
  const isComplete = isRowComplete(row)

  // Wraps onChange to auto-manage ToRemove and warn on manual override
  function handleChange(fieldName, value) {
    if (TO_REMOVE_TRIGGERS.has(fieldName)) {
      const newRow = { ...row, [fieldName]: value }
      if (computeShouldRemove(newRow) && row.ToRemove !== '1') {
        onChange(fieldName, value)
        onChange('ToRemove', '1')
        return
      }
    }

    if (fieldName === 'ToRemove' && value === '0') {
      const triggers = getActiveTriggerLabels(row)
      if (triggers.length > 0) {
        const confirmed = window.confirm(
          `This case has conditions that normally require removal:\n\n• ${triggers.join('\n• ')}\n\nAre you sure you want to set Remove Case = No?`
        )
        if (!confirmed) return
      }
    }

    onChange(fieldName, value)
  }

  // Data integrity check: any integrity fields set to non-default values?
  const triggeredIntegrityFields = INTEGRITY_FIELDS.filter(field => row[field] === '1')
  const hasIntegrityFlags = triggeredIntegrityFields.length > 0
  const hasCaseSummary = row.CaseSummary && row.CaseSummary !== 'NA' && row.CaseSummary !== PENDING && row.CaseSummary.trim() !== ''
  const needsExplanation = hasIntegrityFlags && !hasCaseSummary

  const sourceLines = (row.Sources || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)

  return (
    <div className={`coding-row-card${isComplete ? ' complete' : ''}${needsExplanation ? ' needs-explanation' : ''}${isAddedRow ? ' added-row' : ''}`}>
      {/* Row number bar */}
      <div className="row-number">
        {isAddedRow ? <span className="added-row-badge">+ Added Case</span> : `Row ${rowIndex}`}
        {isComplete && !isAddedRow && <span className="complete-check">✓ Complete</span>}
        {needsExplanation && (
          <span className="explanation-needed">⚠ Document data change in Case Summary</span>
        )}
        {isAddedRow && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
            {isConfirmed ? (
              <span style={{ fontSize: '0.75rem', color: '#276749', fontWeight: 600 }}>✓ Confirmed</span>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onConfirmCase}
                style={{ fontSize: '0.75rem', padding: '0.15rem 0.6rem' }}
              >
                Confirm Custom Case
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDeleteCase}
              style={{ fontSize: '0.75rem', padding: '0.15rem 0.6rem' }}
            >
              Delete Custom Case
            </button>
          </span>
        )}
      </div>

      {/* Data integrity warning banner */}
      {needsExplanation && (
        <div className="integrity-warning">
          Data integrity field{triggeredIntegrityFields.length > 1 ? 's' : ''} set:{' '}
          <strong>{triggeredIntegrityFields.join(', ')}</strong>.{' '}
          Please document what changed and why in the <strong>Case Summary</strong> field below.
        </div>
      )}

      {/* Section A — Read-only source context */}
      <div className="source-section">
        {SOURCE_DISPLAY_FIELDS.map(({ name, label }) => {
          const val = row[name]
          if (!val || val === 'NA') return null
          return (
            <div key={name} className="source-field">
              <span className="field-label">{label}</span>
              <span className="field-value">{val}</span>
            </div>
          )
        })}

        {/* Sources — sanitized links */}
        {sourceLines.length > 0 && (
          <div className="source-field full-width">
            <span className="field-label">Sources</span>
            <div className="sources-list">
              {sourceLines.map((line, i) => {
                const safe = sanitizeUrl(line)
                return (
                  <span key={i} className="source-url-row">
                    <span className="source-url-num">{i + 1}.</span>
                    {safe ? (
                      <a href={safe} target="_blank" rel="noopener noreferrer">{safe}</a>
                    ) : (
                      <span className="unsafe-url">[unsafe URL removed]</span>
                    )}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Section B — Editable coded fields (ordered by MAIN_FIELD_ORDER) */}
      <div className="coded-section">
        {(() => {
          const keySet = new Set(config.keyColumns.map(c => c.name))
          const colByName = Object.fromEntries([
            ...config.keyColumns,
            ...config.supplementaryColumns,
          ].map(c => [c.name, c]))
          return MAIN_FIELD_ORDER.map(name => {
            const col = colByName[name]
            if (!col) return null
            return (
              <CodedField
                key={name}
                col={col}
                value={row[name]}
                row={row}
                onChange={handleChange}
                isKey={keySet.has(name)}
                isFlagged={flaggedFields.has(name)}
              />
            )
          })
        })()}

        {/* Case Summary — structured narrative, flags for integrity */}
        <CaseSummaryField value={row.CaseSummary} needsExplanation={needsExplanation} onChange={handleChange} />

        {/* Notes — additional URLs, source discrepancies, PI flag notes */}
        <NotesField value={row.Notes} onChange={handleChange} />

        {onSave && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gridColumn: '1 / -1', marginTop: '0.25rem' }}>
            <button className="btn btn-primary" onClick={onSave}>Save</button>
          </div>
        )}
      </div>

      {/* Section C — Duplicate / Missing / Custom Cases (collapsible) */}
      <IntegrityPanel
        row={row}
        config={config}
        onChange={handleChange}
        allRows={allRows}
        dataIndex={dataIndex}
        isAddedRow={isAddedRow}
        onAddCase={onAddCase}
      />
    </div>
  )
}

// ── CodedField ────────────────────────────────────────────────────────────────

function CodedField({ col, value, row, onChange, isKey, isFlagged = false }) {
  const isPending = !value || value === PENDING

  // ── agencytype: Special (X) → compound field ──────────────────────────────
  if (col.name === 'agencytype') {
    return <AgencyTypeField col={col} value={value} onChange={onChange} isKey={isKey} isFlagged={isFlagged} />
  }

  // ── agencyname: free text + Unknown toggle ────────────────────────────────
  if (col.name === 'agencyname') {
    return <AgencyNameField col={col} value={value} onChange={onChange} isKey={isKey} isFlagged={isFlagged} />
  }

  // ── rank: free text + Unknown toggle ──────────────────────────────────────
  if (col.name === 'rank') {
    return <RankField col={col} value={value} onChange={onChange} isKey={isKey} isFlagged={isFlagged} />
  }

  // ── type_new: add "Other (specify)" option ────────────────────────────────
  if (col.name === 'type_new') {
    return <TypeNewField col={col} value={value} onChange={onChange} isKey={isKey} isFlagged={isFlagged} />
  }

  // ── ErrorDetail is handled separately outside this component ──────────────

  if (col.type === 'controlled_vocab' && col.values) {
    const valueMap = getValueMap(col.name)
    return (
      <div className="coded-field">
        <label className={isKey ? 'key-label' : ''}>
          {displayName(col.name)}{isKey ? ' *' : ''}
          <InfoTooltip column={col.name} />
        </label>
        <select
          value={isPending ? '' : value}
          onChange={e => onChange(col.name, e.target.value || PENDING)}
          className={isPending ? 'pending' : ''}
          style={isFlagged ? { border: '2px solid #e53e3e' } : {}}
        >
          <option value="">— select —</option>
          {col.values.map(v => (
            <option key={v} value={v}>{valueMap ? valueMap[v] ?? v : v}</option>
          ))}
        </select>
      </div>
    )
  }

  // free_text
  return (
    <div className="coded-field">
      <label>
        {displayName(col.name)}
        <InfoTooltip column={col.name} />
      </label>
      <input
        type="text"
        value={value === 'NA' || value == null || value === PENDING ? '' : value}
        onChange={e => onChange(col.name, e.target.value || 'NA')}
        style={isFlagged ? { border: '2px solid #e53e3e' } : {}}
        placeholder="NA"
      />
    </div>
  )
}

// ── AgencyNameField ───────────────────────────────────────────────────────────

function AgencyNameField({ col, value, onChange, isKey, isFlagged = false }) {
  const isUnknown = value === 'Unknown'
  const isNA      = value === 'N/A'
  const isLocked  = isUnknown || isNA
  const isPending = !value || value === PENDING
  const flagStyle = isFlagged ? { border: '2px solid #e53e3e' } : {}
  const lockedStyle = { background: '#f5f5f5', color: '#888', fontStyle: 'italic', ...flagStyle }
  const toggleBtnStyle = active => ({
    marginTop: '0.2rem',
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.78rem',
    color: active ? '#1a56db' : '#888',
    cursor: 'pointer',
    textDecoration: 'underline',
    textAlign: 'left',
  })

  return (
    <div className="coded-field">
      <label className={isKey ? 'key-label' : ''}>
        {displayName(col.name)}{isKey ? ' *' : ''}
        <InfoTooltip column={col.name} />
      </label>
      <input
        type="text"
        value={isUnknown ? 'Unknown' : isNA ? 'N/A' : (isPending ? '' : value)}
        onChange={e => onChange(col.name, e.target.value || PENDING)}
        placeholder="e.g. Chicago Police Department"
        disabled={isLocked}
        className={isPending && !isLocked ? 'pending' : ''}
        style={isLocked ? lockedStyle : flagStyle}
      />
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button type="button"
          onClick={() => onChange(col.name, isUnknown ? PENDING : 'Unknown')}
          style={toggleBtnStyle(isUnknown)}
        >
          {isUnknown ? 'Clear Unknown' : 'Mark as Unknown'}
        </button>
        <button type="button"
          onClick={() => onChange(col.name, isNA ? PENDING : 'N/A')}
          style={toggleBtnStyle(isNA)}
        >
          {isNA ? 'Clear N/A' : 'Mark as N/A'}
        </button>
      </div>
    </div>
  )
}

// ── RankField ─────────────────────────────────────────────────────────────────

function RankField({ col, value, onChange, isKey, isFlagged = false }) {
  const isUnknown = value === 'Unknown'
  const isNA      = value === 'N/A'
  const isLocked  = isUnknown || isNA
  const isPending = !value || value === PENDING
  const flagStyle = isFlagged ? { border: '2px solid #e53e3e' } : {}
  const lockedStyle = { background: '#f5f5f5', color: '#888', fontStyle: 'italic', ...flagStyle }
  const toggleBtnStyle = active => ({
    marginTop: '0.2rem',
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.78rem',
    color: active ? '#1a56db' : '#888',
    cursor: 'pointer',
    textDecoration: 'underline',
    textAlign: 'left',
  })

  return (
    <div className="coded-field">
      <label className={isKey ? 'key-label' : ''}>
        {displayName(col.name)}{isKey ? ' *' : ''}
        <InfoTooltip column={col.name} />
      </label>
      <input
        type="text"
        value={isUnknown ? 'Unknown' : isNA ? 'N/A' : (isPending ? '' : value)}
        onChange={e => onChange(col.name, e.target.value || PENDING)}
        placeholder="e.g. Officer, Detective, Sergeant…"
        disabled={isLocked}
        className={isPending && !isLocked ? 'pending' : ''}
        style={isLocked ? lockedStyle : flagStyle}
      />
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button type="button"
          onClick={() => onChange(col.name, isUnknown ? PENDING : 'Unknown')}
          style={toggleBtnStyle(isUnknown)}
        >
          {isUnknown ? 'Clear Unknown' : 'Mark as Unknown'}
        </button>
        <button type="button"
          onClick={() => onChange(col.name, isNA ? PENDING : 'N/A')}
          style={toggleBtnStyle(isNA)}
        >
          {isNA ? 'Clear N/A' : 'Mark as N/A'}
        </button>
      </div>
    </div>
  )
}

// ── AgencyTypeField ───────────────────────────────────────────────────────────

function AgencyTypeField({ col, value, onChange, isKey, isFlagged = false }) {
  const isPending = !value || value === PENDING

  // Detect if current value is a Special variant: "Special (Something)"
  const isSpecialVariant = value && value.startsWith('Special (') && value.endsWith(')')
  // Normalize: show "Special (X)" in the dropdown for any Special value
  const selectValue = isPending ? '' : isSpecialVariant ? 'Special (X)' : value
  const specialDetail = isSpecialVariant ? value.slice(9, -1) : ''  // "University" from "Special (University)"

  function handleSelectChange(e) {
    const chosen = e.target.value
    if (!chosen) {
      onChange(col.name, PENDING)
    } else if (chosen === 'Special (X)') {
      // Start with placeholder until user fills in the type
      onChange(col.name, 'Special ()')
    } else {
      onChange(col.name, chosen)
    }
  }

  function handleSpecialDetailChange(e) {
    const detail = e.target.value.trim()
    onChange(col.name, detail ? `Special (${detail})` : 'Special ()')
  }

  return (
    <div className="coded-field">
      <label className={isKey ? 'key-label' : ''}>
        {displayName(col.name)}{isKey ? ' *' : ''}
        <InfoTooltip column={col.name} />
      </label>
      <select
        value={selectValue}
        onChange={handleSelectChange}
        className={isPending ? 'pending' : ''}
        style={isFlagged ? { border: '2px solid #e53e3e' } : {}}
      >
        <option value="">— select —</option>
        {col.values.map(v => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
      {(selectValue === 'Special (X)' || isSpecialVariant) && (
        <input
          type="text"
          value={specialDetail}
          onChange={handleSpecialDetailChange}
          placeholder="e.g. University, School, Transit, Tribal, Park…"
          style={{ marginTop: '0.35rem' }}
          className={!specialDetail ? 'pending' : ''}
        />
      )}
    </div>
  )
}

// ── TypeNewField ──────────────────────────────────────────────────────────────

function TypeNewField({ col, value, onChange, isKey, isFlagged = false }) {
  const { primary, secondary } = parseTypeNew(value)
  const isPending = !value || value === PENDING
  const needsSecondary = TYPE_NEW_NEEDS_SECONDARY.has(primary)
  const secondaryMissing = needsSecondary && !secondary

  function handlePrimaryChange(e) {
    const chosen = e.target.value
    if (!chosen) {
      onChange(col.name, PENDING)
    } else {
      // Store chosen primary immediately; secondary dropdown will appear if needed
      onChange(col.name, chosen)
    }
  }

  function handleSecondaryChange(e) {
    const chosen = e.target.value
    if (!chosen) {
      onChange(col.name, primary)  // revert to primary-only (secondary pending)
    } else {
      onChange(col.name, `${primary}; ${chosen}`)
    }
  }

  return (
    <div className="coded-field">
      <label className={isKey ? 'key-label' : ''}>
        {displayName(col.name)}{isKey ? ' *' : ''}
        <InfoTooltip column={col.name} />
      </label>
      <select
        value={isPending ? '' : primary}
        onChange={handlePrimaryChange}
        className={isPending ? 'pending' : ''}
        style={isFlagged ? { border: '2px solid #e53e3e' } : {}}
      >
        <option value="">— select —</option>
        {TYPE_NEW_PRIMARY.map(v => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
      {needsSecondary && (
        <select
          value={secondary || ''}
          onChange={handleSecondaryChange}
          className={secondaryMissing ? 'pending' : ''}
          style={{ marginTop: '0.35rem' }}
        >
          <option value="">— select subtype —</option>
          {(TYPE_NEW_SECONDARY[primary] || []).map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      )}
    </div>
  )
}

// ── CaseSummaryField ──────────────────────────────────────────────────────────

function CaseSummaryField({ value, needsExplanation, onChange }) {
  const displayValue = value === 'NA' || value === PENDING || value == null ? '' : value

  return (
    <div className="coded-field full-width">
      <label style={needsExplanation ? { color: '#c05621' } : {}}>
        Case Summary
        <InfoTooltip column="CaseSummary" />
        {needsExplanation && <span className="explanation-badge"> — explanation required</span>}
      </label>
      <textarea
        value={displayValue}
        onChange={e => onChange('CaseSummary', e.target.value || 'NA')}
        placeholder={`Format: [Agency type] [Rank] [fatally/non-fatally] shot [wound location] [context].\nExample: "Local Officer non-fatally shot in the leg while responding to a domestic disturbance."`}
        rows={3}
        style={needsExplanation ? { borderColor: '#c05621', background: '#fffaf5' } : {}}
      />
    </div>
  )
}

// ── NotesField ────────────────────────────────────────────────────────────────

function NotesField({ value, onChange }) {
  const displayValue = value === 'NA' || value === PENDING || value == null ? '' : value

  return (
    <div className="coded-field full-width">
      <label>Notes</label>
      <textarea
        value={displayValue}
        onChange={e => onChange('Notes', e.target.value || 'NA')}
        placeholder={`Use this field for anything that doesn't fit in the Case Summary:\n• Additional URLs you found that clarify or contradict the GVA sources\n• Explanation of unusual coding decisions or edge cases\n• Notes on any changes made in the Duplicate / Missing / Custom Cases section\n• Questions or flags for PI review`}
        rows={6}
      />
    </div>
  )
}

// ── SearchableIncidentSelector ────────────────────────────────────────────────

function formatOptionMeta(opt) {
  return [opt.date, [opt.city, opt.state].filter(Boolean).join(', '), opt.name].filter(Boolean).join(' · ')
}

function buildOptions(allRows, currentIndex, idColumn, mode) {
  if (mode === 'incident') {
    const currentId = allRows[currentIndex]?.[idColumn]
    const seen = new Set()
    return allRows
      .filter(r => {
        const id = r[idColumn]
        if (!id || id === currentId || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map(r => ({
        incidentId: r[idColumn],
        date: r.Date || '',
        city: r.Cityorcounty || '',
        state: r.State || '',
        name: (r.Name && r.Name !== 'NA' && r.Name.toLowerCase() !== 'unknown') ? r.Name : null,
        isDuplicate: false,
        rowIndex: allRows.findIndex(row => row[idColumn] === r[idColumn]),
      }))
  }
  // row mode
  return allRows
    .map((r, i) => ({
      incidentId: r[idColumn],
      date: r.Date || '',
      city: r.Cityorcounty || '',
      state: r.State || '',
      name: (r.Name && r.Name !== 'NA' && r.Name.toLowerCase() !== 'unknown') ? r.Name : null,
      isDuplicate: r.Duplicate === '1',
      rowIndex: i,
    }))
    .filter((_, i) => i !== currentIndex)
}

function SearchableIncidentSelector({ allRows, currentIndex, idColumn, value, onChange, mode }) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const options = useMemo(
    () => buildOptions(allRows, currentIndex, idColumn, mode),
    [allRows, currentIndex, idColumn, mode]
  )

  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = query.toLowerCase()
    return options.filter(o =>
      o.incidentId?.toLowerCase().includes(q) ||
      o.date?.toLowerCase().includes(q) ||
      o.city?.toLowerCase().includes(q) ||
      o.state?.toLowerCase().includes(q) ||
      (o.name && o.name.toLowerCase().includes(q))
    )
  }, [options, query])

  const selectedLabel = useMemo(() => {
    if (!value) return ''
    const match = options.find(o => o.incidentId === value)
    if (!match) return value
    const prefix = mode === 'row' ? `Row ${match.rowIndex + 1} · ` : ''
    return `${prefix}${match.incidentId} · ${formatOptionMeta(match)}`
  }, [value, options, mode])

  function handleSelect(opt) {
    if (opt.isDuplicate) {
      window.alert(
        `Row ${opt.rowIndex + 1} is already marked as a duplicate — it cannot be designated as the original case. Please select a different row.`
      )
      return
    }
    onChange(opt.incidentId)
    setQuery('')
    setIsOpen(false)
  }

  const displayValue = isOpen ? query : selectedLabel

  return (
    <div className="searchable-selector">
      <input
        type="text"
        value={displayValue}
        onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
        onFocus={() => { setIsOpen(true); setQuery('') }}
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        placeholder="Search by ID, date, city, name…"
        className={!value ? 'pending' : ''}
      />
      {isOpen && (
        <div className="searchable-dropdown">
          {filtered.length === 0 ? (
            <div className="searchable-option searchable-empty">No matches</div>
          ) : (
            filtered.slice(0, 60).map((opt, i) => (
              <div
                key={i}
                className={`searchable-option${opt.isDuplicate ? ' flagged' : ''}`}
                onMouseDown={() => handleSelect(opt)}
                title={opt.isDuplicate ? 'Already marked as a duplicate — cannot be the original' : ''}
              >
                {mode === 'row' && <span className="opt-row">Row {opt.rowIndex + 1}</span>}
                {opt.isDuplicate && <span className="opt-flag">⚠</span>}
                <span className="opt-id">{opt.incidentId}</span>
                <span className="opt-meta">{formatOptionMeta(opt)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── DuplicateField ────────────────────────────────────────────────────────────

function DuplicateField({ row, config, onChange, allRows, dataIndex }) {
  const isDuplicate = row.Duplicate === '1'
  const dupType = (row.duplicate_type && row.duplicate_type !== PENDING && row.duplicate_type !== 'NA') ? row.duplicate_type : ''

  let selectValue = ''
  if (isDuplicate && dupType === 'row') selectValue = 'row'

  function handleChange(e) {
    const val = e.target.value
    if (!val) {
      onChange('Duplicate', PENDING)
      onChange('duplicate_type', 'NA')
      onChange('duplicate_of', 'NA')
    } else if (val === 'row') {
      onChange('Duplicate', '1')
      onChange('duplicate_type', 'row')
    }
  }

  const dupOfValue = (row.duplicate_of && row.duplicate_of !== 'NA' && row.duplicate_of !== PENDING) ? row.duplicate_of : ''

  return (
    <div className="coded-field">
      <label>
        Duplicate Case?
        <InfoTooltip column="Duplicate" />
      </label>
      <select
        value={selectValue}
        onChange={handleChange}
      >
        <option value="">— not a duplicate —</option>
        <option value="row">Yes — this officer row is a duplicate</option>
      </select>

      {isDuplicate && dupType === 'row' && (
        <div style={{ marginTop: '0.5rem' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600, color: '#444', display: 'block', marginBottom: '0.2rem' }}>
            Duplicate of Row
            <InfoTooltip column="duplicate_of" />
          </label>
          <SearchableIncidentSelector
            allRows={allRows}
            currentIndex={dataIndex}
            idColumn={config.idColumn}
            value={dupOfValue}
            onChange={val => onChange('duplicate_of', val)}
            mode="row"
          />
        </div>
      )}
    </div>
  )
}

// ── SeparateIncidentField ─────────────────────────────────────────────────────

function SeparateIncidentField({ row, config, onChange, allRows, dataIndex }) {
  const isChanged = row.incident_id_changed === '1'
  const changeType = (row.incident_change_type && row.incident_change_type !== PENDING && row.incident_change_type !== 'NA') ? row.incident_change_type : ''

  let selectValue = ''
  if (row.incident_id_changed === '0') selectValue = 'no'
  else if (isChanged && changeType === 'reassign') selectValue = 'reassign'
  else if (isChanged && changeType === 'new_id') selectValue = 'new_id'

  const incidentId = row[config.idColumn]

  function handleChange(e) {
    const val = e.target.value
    if (!val) {
      onChange('incident_id_changed', PENDING)
      onChange('incident_change_type', 'NA')
      onChange('reassign_to_id', 'NA')
      return
    }
    if (val === 'reassign') {
      const confirmed = window.confirm(
        `You're indicating that Incident ID ${incidentId} is incorrect for this case — ` +
        `it should be reassigned to a different existing incident in the data.\n\n` +
        `Use the selector below to find and select the correct incident.`
      )
      if (!confirmed) return
      onChange('incident_id_changed', '1')
      onChange('incident_change_type', 'reassign')
    } else if (val === 'new_id') {
      const confirmed = window.confirm(
        `You're indicating that Incident ID ${incidentId} is incorrect for this case, ` +
        `and it does not correspond to any other incident in the dataset.\n\n` +
        `The PI will assign a new Incident ID during review. Continue?`
      )
      if (!confirmed) return
      onChange('incident_id_changed', '1')
      onChange('incident_change_type', 'new_id')
      onChange('reassign_to_id', 'NA')
    }
  }

  const reassignValue = (row.reassign_to_id && row.reassign_to_id !== 'NA' && row.reassign_to_id !== PENDING) ? row.reassign_to_id : ''

  return (
    <div className="coded-field">
      <label>
        Incorrect Incident ID?
        <InfoTooltip column="incident_id_changed" />
      </label>
      <select
        value={selectValue}
        onChange={handleChange}
      >
        <option value="">— ID is correct —</option>
        <option value="reassign">Yes — ID {incidentId} should be changed to another existing Incident ID</option>
        <option value="new_id">Yes — ID {incidentId} is incorrect and no other Incident ID applies (assign new)</option>
      </select>

      {isChanged && changeType === 'reassign' && (
        <div style={{ marginTop: '0.5rem' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600, color: '#444', display: 'block', marginBottom: '0.2rem' }}>
            Reassign to Incident
          </label>
          <SearchableIncidentSelector
            allRows={allRows}
            currentIndex={dataIndex}
            idColumn={config.idColumn}
            value={reassignValue}
            onChange={val => onChange('reassign_to_id', val)}
            mode="incident"
          />
        </div>
      )}

      {isChanged && changeType === 'new_id' && (
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem', color: '#666', fontStyle: 'italic' }}>
          PI will assign a new Incident ID during review. Document details in Case Summary or Notes.
        </p>
      )}
    </div>
  )
}

// ── IntegrityPanel ────────────────────────────────────────────────────────────

function IntegrityPanel({ row, config, onChange, allRows, dataIndex, isAddedRow, onAddCase }) {
  // Only flag when explicitly set to '1' — PENDING and '0' are not flags
  const flagCount = ['Duplicate', 'incident_id_changed'].filter(f => row[f] === '1').length

  const [open, setOpen] = useState(flagCount > 0)

  return (
    <div className="integrity-panel">
      <button
        type="button"
        className="integrity-panel-toggle"
        onClick={() => setOpen(o => !o)}
      >
        <span>Missing / Duplicate Cases and Incident IDs Options</span>
        {flagCount > 0 && <span className="integrity-flag-badge">{flagCount} flag{flagCount !== 1 ? 's' : ''}</span>}
        <span className="integrity-panel-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="integrity-panel-body">
          {/* Add Case — first, most common action */}
          {!isAddedRow && (
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <button type="button" className="btn btn-secondary" onClick={onAddCase}>
                + Add Case Under This Incident ID
              </button>
              <InfoTooltip column="add_case" />
            </div>
          )}

          <DuplicateField
            row={row}
            config={config}
            onChange={onChange}
            allRows={allRows}
            dataIndex={dataIndex}
          />

          <SeparateIncidentField
            row={row}
            config={config}
            onChange={onChange}
            allRows={allRows}
            dataIndex={dataIndex}
          />
        </div>
      )}
    </div>
  )
}


// ── Named exports for NewIncidentForm ─────────────────────────────────────────
export {
  InfoTooltip, AgencyNameField, AgencyTypeField, TypeNewField, RankField,
  DISPLAY_NAMES, COLUMN_INFO, YES_NO_MAP, getValueMap,
  computeShouldRemove, TO_REMOVE_TRIGGERS, getActiveTriggerLabels,
}
