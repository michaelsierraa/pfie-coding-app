import { useState, useEffect, useCallback } from 'react'
import { useConfig } from './hooks/useConfig.js'
import { useCoderSession } from './hooks/useCoderSession.js'
import { useSampleData } from './hooks/useSampleData.js'
import { getAuthenticatedUser } from './lib/github.js'
import Login from './components/Login.jsx'
import SampleTable from './components/SampleTable.jsx'
import PIReviewDashboard from './components/PIReviewDashboard.jsx'

const WORKER_URL = import.meta.env.VITE_WORKER_URL

/**
 * App — top-level auth gate.
 *
 * Flow:
 *   1. Check sessionStorage for existing token.
 *   2. If URL has ?code=...&state=..., handle OAuth callback → exchange → store token.
 *   3. No token → show Login (GitHub OAuth button).
 *   4. Token present → mount AuthenticatedApp (fetches config + resolves identity).
 */
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('gh_token'))
  const [exchanging, setExchanging] = useState(false)
  const [authError, setAuthError] = useState(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    if (!code) return

    // Clean URL before anything else
    window.history.replaceState({}, '', window.location.pathname)

    const savedState = sessionStorage.getItem('oauth_state')
    sessionStorage.removeItem('oauth_state')

    if (!savedState || state !== savedState) {
      setAuthError('OAuth state mismatch. Please try signing in again.')
      return
    }

    setExchanging(true)
    fetch(`${WORKER_URL}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        sessionStorage.setItem('gh_token', data.access_token)
        setToken(data.access_token)
      })
      .catch(e => setAuthError(e.message || 'Authentication failed.'))
      .finally(() => setExchanging(false))
  }, [])

  function handleLogout() {
    sessionStorage.removeItem('gh_token')
    setToken(null)
    setAuthError(null)
  }

  if (exchanging) {
    return <div className="loading">Signing in…</div>
  }

  if (authError) {
    return (
      <div className="loading">
        <div className="alert alert-error" style={{ maxWidth: 480 }}>
          {authError}
          <br />
          <button
            className="btn btn-secondary"
            onClick={() => setAuthError(null)}
            style={{ marginTop: '0.5rem' }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!token) {
    return <Login />
  }

  return <AuthenticatedApp token={token} onLogout={handleLogout} />
}

/**
 * AuthenticatedApp — mounts only after a valid token is in hand.
 * Fetches config via the Worker, resolves GitHub identity against the coder map,
 * then hands off to CodingView.
 */
function AuthenticatedApp({ token, onLogout }) {
  const [coderName, setCoderName] = useState(null)
  const [identityError, setIdentityError] = useState(null)

  const fetchFn = useCallback(
    () =>
      fetch(`${WORKER_URL}/config`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => {
        if (!r.ok) throw new Error(`Failed to load config: ${r.status}`)
        return r.text()
      }),
    [token]
  )

  const { config, loading: configLoading, error: configError } = useConfig(fetchFn)

  const [isPI, setIsPI] = useState(false)
  // 'home' = PIDashboard, 'review' = PIReviewDashboard; coderName being set means coder view
  const [piView, setPiView] = useState('home')

  // Once config is loaded, resolve GitHub identity → display name (or PI flag)
  useEffect(() => {
    if (!config) return
    getAuthenticatedUser(token)
      .then(user => {
        if (!user) throw new Error('Could not verify GitHub identity.')
        if (config.isPIUser(user.login)) {
          setIsPI(true)
          return
        }
        const assignment = config.getCoderByGithub(user.login)
        if (!assignment) {
          throw new Error(
            `GitHub account @${user.login} is not assigned to any sample. Contact the PI.`
          )
        }
        setCoderName(assignment.name)
      })
      .catch(e => setIdentityError(e.message))
  }, [config, token])

  if (configLoading || (!coderName && !isPI && !identityError && !configError)) {
    return <div className="loading">Loading…</div>
  }

  if (configError) {
    return (
      <div className="loading">
        <div className="alert alert-error" style={{ maxWidth: 480 }}>
          <strong>Configuration error:</strong> {configError}
        </div>
      </div>
    )
  }

  if (identityError) {
    return (
      <div className="loading">
        <div className="alert alert-error" style={{ maxWidth: 480 }}>
          {identityError}
          <br />
          <button className="btn btn-secondary" onClick={onLogout} style={{ marginTop: '0.5rem' }}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  // PI with a coder selected → coder view (onPIBack returns to wherever PI came from)
  if (isPI && coderName) {
    return (
      <CodingView
        coderName={coderName}
        config={config}
        token={token}
        onLogout={onLogout}
        isPI={isPI}
        onPIBack={() => setCoderName(null)}
      />
    )
  }

  // PI review queue
  if (isPI && piView === 'review') {
    return (
      <PIReviewDashboard
        config={config}
        token={token}
        onBack={() => setPiView('home')}
        onViewCoder={name => setCoderName(name)}
      />
    )
  }

  // PI home — coder picker + review queue entry
  if (isPI) {
    return (
      <PIDashboard
        config={config}
        onSelectCoder={setCoderName}
        onOpenReview={() => setPiView('review')}
        onLogout={onLogout}
      />
    )
  }

  return (
    <CodingView
      coderName={coderName}
      config={config}
      token={token}
      onLogout={onLogout}
      isPI={false}
      onPIBack={null}
    />
  )
}

function PIDashboard({ config, onSelectCoder, onOpenReview, onLogout }) {
  const [selected, setSelected] = useState('')
  const coderNames = Object.keys(config.coderMap).sort()

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <h1>IRR Coding App</h1>
        <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Signed in as PI</p>

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', marginTop: '0.75rem' }}>
          <p style={{ fontSize: '0.875rem', color: '#555', marginBottom: '0.75rem' }}>
            Review flagged rows across all coders and pairs.
          </p>
          <button
            className="btn btn-primary"
            onClick={onOpenReview}
            style={{ width: '100%' }}
          >
            PI Review Queue →
          </button>
        </div>

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', marginTop: '1rem' }}>
          <p style={{ fontSize: '0.875rem', color: '#555', marginBottom: '0.5rem' }}>
            View a coder's sample exactly as they see it.
          </p>
          <label htmlFor="pi-coder-select">Coder</label>
          <select
            id="pi-coder-select"
            value={selected}
            onChange={e => setSelected(e.target.value)}
          >
            <option value="">— Select a coder —</option>
            {coderNames.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <button
            className="btn btn-secondary"
            disabled={!selected}
            onClick={() => onSelectCoder(selected)}
            style={{ width: '100%', marginTop: '0.75rem' }}
          >
            View Coder Sample →
          </button>
        </div>

        <button
          className="btn btn-secondary"
          onClick={onLogout}
          style={{ width: '100%', marginTop: '1rem' }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/**
 * CodingView — loads the coder's sample data and renders the SampleTable.
 * Separated so useSampleData only runs after login.
 */
function CodingView({ coderName, config, token, onLogout, isPI, onPIBack }) {
  const session = useCoderSession(coderName, config)

  const {
    rows,
    setRows,
    loading,
    error,
    saveProgress,
    submitCoding,
    addMissingCase,
    lastSaved,
  } = useSampleData(
    session?.fileUrl ?? null,
    session?.filename ?? null,
    coderName,
    session?.sampleId ?? null,
    config,
    token,
    session?.role ?? null,
    isPI
  )

  if (!session) {
    return (
      <div className="loading">
        <div className="alert alert-error" style={{ maxWidth: 480 }}>
          No assignment found for <strong>{coderName}</strong>.{' '}
          <button className="btn btn-secondary" onClick={onLogout} style={{ marginTop: '0.5rem' }}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className="loading">Loading {session.filename}…</div>
  }

  if (error) {
    return (
      <div className="loading">
        <div className="alert alert-error" style={{ maxWidth: 480 }}>
          <strong>Error loading sample:</strong> {error}
          <br />
          <button className="btn btn-secondary" onClick={onLogout} style={{ marginTop: '0.5rem' }}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <SampleTable
      coderName={coderName}
      session={session}
      config={config}
      rows={rows}
      setRows={setRows}
      saveProgress={saveProgress}
      addMissingCase={addMissingCase}
      submitCoding={submitCoding}
      lastSaved={lastSaved}
      onLogout={onLogout}
      onPIBack={onPIBack}
    />
  )
}
