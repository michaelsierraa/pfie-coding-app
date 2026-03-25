# Architecture

_Full architecture documentation coming as part of the initial build._

## High-level flow

1. Coder visits the app URL
2. App redirects to GitHub OAuth
3. Cloudflare Worker exchanges the OAuth code for a GitHub token (keeps client secret off the frontend)
4. App checks that the authenticated user is a member of the configured data repository
5. App reads `irr_config.yaml` from the data repository via GitHub Contents API
6. Coder sees their assigned sample rows with source fields pre-populated
7. Coder submits coding → app writes their CSV to the data repository as a Git commit
8. GitHub Action fires → calculates IRR → commits updated report back to the repository
