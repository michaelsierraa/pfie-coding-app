const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID

/**
 * Phase 2 login: redirects to GitHub OAuth.
 * No config needed — identity is resolved after auth via the Worker.
 */
export default function Login() {
  function handleSignIn() {
    const nonce = crypto.randomUUID()
    sessionStorage.setItem('oauth_state', nonce)
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      state: nonce,
      scope: 'read:user',
    })
    window.location.href = `https://github.com/login/oauth/authorize?${params}`
  }

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <h1>IRR Coding App</h1>
        <p>Sign in with your GitHub account to access your assigned coding sample.</p>
        <button className="btn btn-primary" onClick={handleSignIn} style={{ width: '100%' }}>
          Sign in with GitHub
        </button>
        <p style={{ marginTop: '1.5rem', fontSize: '0.78rem', color: '#aaa' }}>
          Access is restricted to assigned coders. Contact the PI if you have trouble signing in.
        </p>
      </div>
    </div>
  )
}
