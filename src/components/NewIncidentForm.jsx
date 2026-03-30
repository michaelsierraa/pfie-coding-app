import { useState } from 'react'
import { isRowComplete } from '../hooks/useSampleData.js'
import {
  InfoTooltip, AgencyNameField, AgencyTypeField, TypeNewField, RankField,
  DISPLAY_NAMES, COLUMN_INFO, getValueMap,
  computeShouldRemove, TO_REMOVE_TRIGGERS, getActiveTriggerLabels,
} from './CodingRow.jsx'

const PENDING = 'PENDING'

const GENDER_OPTIONS = ['Male', 'Female', 'Unknown']

const CODED_ORDER = [
  'Status2', 'agencytype', 'agencyname', 'type_new',
  'notactiveswornlocalstate', 'rank', 'offduty', 'training', 'blueonblue', 'ToRemove',
]

// Format: 999YYYYMMDDX — 999 prefix + incident date + trailing digit
// Matches convention in GVA_Project_Onboarding (Feb 2026+)
function generateNewID(dateStr, allRows, idColumn) {
  const cleaned = (dateStr || '').replace(/-/g, '').replace(/\//g, '').slice(0, 8)
  if (cleaned.length !== 8 || !/^\d{8}$/.test(cleaned)) return null
  const prefix = `999${cleaned}`
  const existing = allRows.filter(r => String(r[idColumn] || '').startsWith(prefix)).length
  return `${prefix}${existing + 1}`
}

function initFormData(config) {
  const allCodedFields = [
    ...config.keyColumns.map(c => c.name),
    ...config.supplementaryColumns.map(c => c.name),
  ]
  return {
    Date: '',
    State: '',
    Cityorcounty: '',
    Name: '',
    Gender: PENDING,
    ...Object.fromEntries(allCodedFields.map(f => [f, PENDING])),
    CaseSummary: '',
    Notes: '',
    record_added: '1',
    incident_id_changed: '0',
    incident_change_type: 'NA',
    reassign_to_id: 'NA',
    Duplicate: '0',
    duplicate_type: 'NA',
    duplicate_of: 'NA',
    original_id: 'NA',
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RequiredText({ label, value, onChange, placeholder, showError }) {
  const empty = !value || !value.trim()
  return (
    <div className="coded-field">
      <label>{label} *</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={showError && empty ? { borderColor: '#e53e3e' } : {}}
      />
    </div>
  )
}

function NameField({ value, onChange }) {
  const isUnknown = value === 'Unknown'
  const isPending = !value || value === PENDING
  return (
    <div className="coded-field">
      <label>Name</label>
      <input
        type="text"
        value={isUnknown ? 'Unknown' : (isPending ? '' : value)}
        onChange={e => onChange(e.target.value || PENDING)}
        placeholder="Officer name (if known)"
        disabled={isUnknown}
        style={isUnknown ? { background: '#f5f5f5', color: '#888', fontStyle: 'italic' } : {}}
      />
      <button
        type="button"
        onClick={() => onChange(isUnknown ? PENDING : 'Unknown')}
        style={{
          marginTop: '0.2rem', background: 'none', border: 'none', padding: 0,
          fontSize: '0.78rem', color: isUnknown ? '#1a56db' : '#888',
          cursor: 'pointer', textDecoration: 'underline', textAlign: 'left',
        }}
      >
        {isUnknown ? 'Clear — enter Name' : 'Mark as Unknown'}
      </button>
    </div>
  )
}

function GenderField({ value, onChange, showError }) {
  const isPending = !value || value === PENDING
  return (
    <div className="coded-field">
      <label>Gender *</label>
      <select
        value={isPending ? '' : value}
        onChange={e => onChange(e.target.value || PENDING)}
        className={isPending ? 'pending' : ''}
        style={showError && isPending ? { borderColor: '#e53e3e' } : {}}
      >
        <option value="">— select —</option>
        {GENDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function UrlList({ urls, onUrlChange }) {
  return (
    <div className="coded-field full-width">
      <label>Sources</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {urls.map((url, i) => (
          <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              type="text"
              value={url}
              onChange={e => onUrlChange('update', i, e.target.value)}
              placeholder="https://…"
              style={{
                flex: 1, padding: '0.4rem 0.6rem', border: '1px solid #ccc',
                borderRadius: '4px', fontSize: '0.88rem', fontFamily: 'inherit',
              }}
            />
            {urls.length > 1 && (
              <button
                type="button"
                onClick={() => onUrlChange('remove', i)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c53030', fontSize: '1.1rem', padding: '0 0.2rem', lineHeight: 1 }}
                aria-label="Remove URL"
              >×</button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => onUrlChange('add')}
          style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
            fontSize: '0.82rem', color: '#1a56db', cursor: 'pointer', textDecoration: 'underline',
          }}
        >+ Add URL</button>
      </div>
    </div>
  )
}

function SimpleSelect({ name, col, value, onChange, showError }) {
  const isPending = !value || value === PENDING
  return (
    <div className="coded-field">
      <label>
        {DISPLAY_NAMES[name] || name} *
        <InfoTooltip column={name} />
      </label>
      <select
        value={isPending ? '' : value}
        onChange={e => onChange(name, e.target.value || PENDING)}
        className={isPending ? 'pending' : ''}
        style={showError && isPending ? { borderColor: '#e53e3e' } : {}}
      >
        <option value="">— select —</option>
        {(col.values || []).map(v => {
          const vm = getValueMap(name)
          return <option key={v} value={v}>{vm ? (vm[v] ?? v) : v}</option>
        })}
      </select>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NewIncidentForm({ config, allRows, onSubmit, onCancel }) {
  const [formData, setFormData] = useState(() => initFormData(config))
  const [urls, setUrls] = useState([''])
  const [submitAttempted, setSubmitAttempted] = useState(false)

  const newID = generateNewID(formData.Date, allRows, config.idColumn)

  const colByName = Object.fromEntries([
    ...config.keyColumns,
    ...config.supplementaryColumns,
  ].map(c => [c.name, c]))

  const keyNames = new Set(config.keyColumns.map(c => c.name))

  function handleChange(fieldName, value) {
    if (fieldName === 'ToRemove' && value === '0') {
      const triggers = getActiveTriggerLabels(formData)
      if (triggers.length > 0) {
        const confirmed = window.confirm(
          `This case has conditions that normally require removal:\n\n• ${triggers.join('\n• ')}\n\nAre you sure you want to set Remove Case = No?`
        )
        if (!confirmed) return
      }
    }
    setFormData(prev => {
      const next = { ...prev, [fieldName]: value }
      if (TO_REMOVE_TRIGGERS.has(fieldName) && computeShouldRemove(next) && next.ToRemove !== '1') {
        next.ToRemove = '1'
      }
      return next
    })
  }

  function handleUrlChange(action, index, value) {
    if (action === 'add') setUrls(prev => [...prev, ''])
    else if (action === 'remove') setUrls(prev => prev.filter((_, i) => i !== index))
    else setUrls(prev => prev.map((u, i) => i === index ? value : u))
  }

  function isValid() {
    if (!formData.Date.trim() || !formData.State.trim() || !formData.Cityorcounty.trim()) return false
    if (!formData.Gender || formData.Gender === PENDING) return false
    if (!formData.CaseSummary.trim()) return false
    return isRowComplete(formData)
  }

  function handleSubmit() {
    setSubmitAttempted(true)
    if (!isValid()) return
    if (!newID) return  // date missing — ID can't be generated
    const sources = urls.filter(u => u.trim()).join('\n')
    const newRow = { ...formData, [config.idColumn]: newID, Sources: sources || 'NA' }
    for (const key of Object.keys(newRow)) {
      if (newRow[key] === PENDING) newRow[key] = 'NA'
    }
    onSubmit(newRow)
  }

  const showErr = submitAttempted

  return (
    <div className="new-incident-panel">

      <div className="new-incident-header">
        <div>
          <strong>Add New Incident</strong>
          <span className="new-incident-id-label">
            {newID
              ? <>Incident ID: <code>{newID}</code></>
              : <span style={{ color: '#888', fontStyle: 'italic' }}>Enter a date above to generate ID</span>
            }
          </span>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onCancel} style={{ fontSize: '0.82rem' }}>
          Cancel
        </button>
      </div>

      <div className="new-incident-warning">
        Only use this form for incidents found during source research that have <strong>no existing record in the GVA dataset</strong>. This is rare. If the incident already has an ID in the data, use "Add Case" or "Incorrect Incident ID?" on the relevant row instead.
      </div>

      {submitAttempted && !isValid() && (
        <div className="alert alert-error" style={{ margin: '0 1rem 0.5rem' }}>
          All fields marked * are required. Dropdowns may be answered with "Unknown" where applicable.
        </div>
      )}

      {/* ── Source information ── */}
      <div className="new-incident-section-label">Source Information</div>
      <div className="coded-section">
        <RequiredText label="Date" value={formData.Date} onChange={v => handleChange('Date', v)} placeholder="e.g. 2024-03-15" showError={showErr} />
        <RequiredText label="State" value={formData.State} onChange={v => handleChange('State', v)} placeholder="e.g. Illinois" showError={showErr} />
        <RequiredText label="City / County" value={formData.Cityorcounty} onChange={v => handleChange('Cityorcounty', v)} placeholder="e.g. Chicago" showError={showErr} />
        <NameField value={formData.Name} onChange={v => handleChange('Name', v)} />
        <GenderField value={formData.Gender} onChange={v => handleChange('Gender', v)} showError={showErr} />
        <UrlList urls={urls} onUrlChange={handleUrlChange} />
      </div>

      {/* ── Coded fields ── */}
      <div className="new-incident-section-label">Coding</div>
      <div className="coded-section">
        {CODED_ORDER.map(name => {
          const col = colByName[name]
          if (!col) return null
          const isKey = keyNames.has(name)

          if (name === 'agencytype') return <AgencyTypeField key={name} col={col} value={formData[name]} onChange={handleChange} isKey={isKey} />
          if (name === 'agencyname') return <AgencyNameField key={name} col={col} value={formData[name]} onChange={handleChange} isKey={isKey} />
          if (name === 'type_new')   return <TypeNewField    key={name} col={col} value={formData[name]} onChange={handleChange} isKey={isKey} />
          if (name === 'rank')       return <RankField       key={name} col={col} value={formData[name]} onChange={handleChange} isKey={false} />

          if (col.type === 'controlled_vocab' && col.values) {
            return <SimpleSelect key={name} name={name} col={col} value={formData[name]} onChange={handleChange} showError={showErr} />
          }
          return (
            <div key={name} className="coded-field">
              <label>{DISPLAY_NAMES[name] || name}<InfoTooltip column={name} /></label>
              <input
                type="text"
                value={formData[name] === PENDING || formData[name] === 'NA' ? '' : formData[name]}
                onChange={e => handleChange(name, e.target.value || PENDING)}
                placeholder="NA"
              />
            </div>
          )
        })}
      </div>

      {/* ── Notes ── */}
      <div className="new-incident-section-label">Notes</div>
      <div className="coded-section">
        <div className="coded-field full-width">
          <label style={showErr && !formData.CaseSummary.trim() ? { color: '#c05621' } : {}}>
            Case Summary *
            <InfoTooltip column="CaseSummary" />
          </label>
          <textarea
            value={formData.CaseSummary}
            onChange={e => handleChange('CaseSummary', e.target.value)}
            placeholder="Format: [Agency type] [Rank] [fatally/non-fatally] shot [wound location] [context]."
            rows={3}
            style={showErr && !formData.CaseSummary.trim() ? { borderColor: '#c05621', background: '#fffaf5' } : {}}
          />
        </div>
        <div className="coded-field full-width">
          <label>Notes</label>
          <textarea
            value={formData.Notes}
            onChange={e => handleChange('Notes', e.target.value)}
            placeholder="Additional sources, context, or questions for PI review."
            rows={3}
          />
        </div>
      </div>

      <div className="new-incident-footer">
        <button type="button" className="btn btn-primary" onClick={handleSubmit}>
          Add to Dataset
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <span className="new-incident-footer-note">
          Appended to end of dataset · Flagged for PI review
        </span>
      </div>

    </div>
  )
}
