const GITHUB_API = 'https://api.github.com'

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) return null
  return res.json()
}
