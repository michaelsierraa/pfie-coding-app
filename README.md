# IRR Coding App

A web-based platform for collaborative research data coding with built-in inter-rater reliability (IRR) analysis. Designed for research teams that need multiple coders to independently classify cases from a shared dataset, then measure and reconcile coding disagreements.

---

## What this is

Research projects that rely on human coding — classifying incidents, coding behaviors, labeling text — face a recurring set of logistical and methodological problems:

- Coders work independently, often in separate files sent by email, returned in inconsistent formats
- Free-text entry produces spurious disagreements from misspellings, inconsistent capitalization, and non-standard abbreviations that obscure real disagreements
- IRR has to be calculated manually after files are collected and reconciled
- There is no native way for coders to flag uncertain cases for PI review
- Onboarding new coders and offboarding departing ones requires managing separate file distributions
- The audit trail for who coded what, when, and what changed is weak or nonexistent

This platform replaces that workflow with a browser-based coding interface that enforces controlled vocabulary, centralizes submissions, calculates IRR automatically, and stores every coding decision as a Git commit.

---

## How it works

Each research project provides an `irr_config.yaml` file in its data repository. This config defines:

- The columns to be coded and their types (controlled vocabulary vs. free text)
- The valid values for each controlled-vocabulary column
- The coder pairs assigned to each IRR sample
- The fields from the source data that are ground truth (used to identify cases)
- The IRR agreement threshold required to proceed to full coding

The app reads this config and becomes a coding interface tailored to that project — no code changes required to adapt it to a new corpus.

Coders authenticate with their GitHub accounts. Access is controlled by membership in the data repository. Adding or removing a coder means adding or removing them from the repo.

Each coding submission is written back to the data repository as a Git commit via the GitHub API, providing a full audit trail and preserving replicability.

---

## Example use case: GVA Police Firearm Assault Coding Project

The immediate use case driving this platform is a study of fatal and nonfatal firearm assaults on U.S. police officers, using data from the [Gun Violence Archive](https://www.gunviolencearchive.org/) (GVA).

**The data:** Each row in the dataset represents one officer shot in one incident. A single incident can involve multiple officers (multiple rows). The dataset covers 2024–2025 and contains ~760 rows across ~600 unique incidents.

**The coding task:** Research assistants classify each case on four key columns:

| Column | Type | Values |
|--------|------|--------|
| `Status2` | Controlled vocab | `Fatal`, `Non-fatal`, `N/A` |
| `agencytype` | Controlled vocab | `Local`, `Sheriff`, `State`, `Special (X)`, `Federal`, `Corrections`, `Unknown`, `N/A` |
| `type_new` | Controlled vocab | `Suspect-inflicted`, `Suspect-inflicted; Accidental`, `Accidental; Blue-On-Blue`, `Accidental; Self-inflicted`, `Self-inflicted; Suicide`, `N/A` |
| `ToRemove` | Controlled vocab | `0`, `1` |

Plus a set of supplementary fields including agency name, officer rank, and flags for off-duty, training, and blue-on-blue incidents.

**The IRR process:** Before coders work through the full dataset, each coder pair independently codes a 25-incident sample. IRR (percent agreement) is calculated across all key columns. A mean agreement of ≥90% is required before a pair proceeds to full coding batch assignments. Disagreements are reviewed and reconciled by the coder pair before proceeding.

**Why this platform matters for this project:** The current workflow produces systematic formatting errors (misspelled controlled vocab values, wrong capitalization) that create false disagreements and require manual correction before IRR can be calculated. The platform eliminates these at the source by replacing free-text entry with dropdowns.

---

## Adapting this platform for your project

This platform is designed to be reusable across research projects. To use it for a new corpus:

1. Create a private GitHub repository for your data
2. Add an `irr_config.yaml` to that repository defining your columns, vocabulary, coder assignments, and IRR threshold (see [config schema](docs/irr_config_schema.md))
3. Add your coders as collaborators on the data repository
4. Point this app at your data repository

No changes to the platform code are required for projects that fit the standard IRR coding workflow. Future versions will support additional workflows (e.g., adjudication interfaces, multi-round coding, batch coding after IRR clearance).

---

## Project structure

```
irr-coding-app/
├── README.md
├── docs/
│   ├── irr_config_schema.md       # Full schema reference for irr_config.yaml
│   ├── architecture.md            # Auth flow, GitHub API usage, data storage model
│   └── adapting.md                # Guide for researchers adapting this to a new project
├── src/
│   ├── app/                       # React app (Vite)
│   │   ├── components/
│   │   │   ├── CodingRow.jsx      # Per-row coding interface (dropdowns + free text)
│   │   │   ├── SampleTable.jsx    # Full sample view for a coder
│   │   │   ├── Dashboard.jsx      # PI dashboard: IRR live, flags, submission status
│   │   │   └── ReconcileView.jsx  # Side-by-side disagreement reconciliation
│   │   ├── lib/
│   │   │   ├── github.js          # GitHub Contents API read/write
│   │   │   ├── irr.js             # Percent agreement calculation (client-side)
│   │   │   └── config.js          # irr_config.yaml parser
│   │   └── main.jsx
│   └── auth/
│       └── worker.js              # Cloudflare Worker: GitHub OAuth token exchange
├── .github/
│   └── workflows/
│       └── irr_report.yml         # GitHub Action: runs IRR calc on coder submission, commits report
└── public/
```

---

## Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React (Vite) | Component model suits per-row coding UI |
| Hosting | Netlify (free tier) | Auto-deploys from GitHub; no server to maintain |
| Auth | GitHub OAuth | Repo membership = access; no separate user system |
| OAuth proxy | Cloudflare Worker (free) | Handles GitHub OAuth secret server-side |
| Data storage | GitHub Contents API | Every submission is a Git commit; full audit trail |
| IRR calculation | Client-side JS + GitHub Actions | Instant local preview; authoritative report on push |

---

## Status

Early development. The IRR methodology, config schema, and analysis pipeline are defined and battle-tested on the GVA project. Frontend and auth infrastructure are next.

See [docs/architecture.md](docs/architecture.md) for the full design.
