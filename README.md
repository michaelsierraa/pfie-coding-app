# pfie-coding-app

A browser-based coding interface for research teams conducting inter-rater reliability (IRR) assessments. Built to replace manual spreadsheet workflows that produce systematic formatting errors — misspellings, capitalization inconsistencies, non-standard abbreviations — that create false disagreements and require manual correction before IRR can be calculated.

---

## Purpose

Research projects that rely on human coding face a recurring set of problems:

- Coders work independently in separate files, returned in inconsistent formats
- Free-text entry produces spurious disagreements that obscure real ones
- IRR must be calculated manually after files are collected and reconciled
- There is no native way to flag uncertain cases for PI review
- The audit trail for who coded what, when, and what changed is weak or nonexistent

This app replaces that workflow with a controlled coding interface that enforces consistent vocabulary via dropdowns, auto-saves draft progress, flags cases for PI review, and produces submissions in a format that passes directly into the IRR analysis pipeline without pre-processing.

---

## Functionality

- **Controlled vocabulary**: all categorical fields use dropdowns, eliminating free-text entry errors
- **Incident grouping**: cases are grouped by incident (one incident at a time) — multi-officer incidents stay together
- **Draft persistence**: progress is auto-saved locally; coders can close and return without losing work
- **Completion tracking**: per-case and per-incident completion status visible in an overview panel
- **PI review flags**: cases coded `Unknown` on key fields, or with integrity issues, are automatically surfaced for PI review
- **ToRemove logic**: cases meeting exclusion criteria (off-duty, training, non-suspect-inflicted, etc.) are auto-flagged with confirmation dialogs
- **Integrity tools**: coders can flag duplicate cases, incorrect incident IDs, and add missing cases found during source research
- **CSV export**: submissions serialize to a validated CSV whose column order and encoding pass directly into the R IRR script

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | React 18 + Vite |
| Hosting | Netlify |
| Auth | GitHub OAuth (via Cloudflare Worker) |
| Data access | GitHub Contents API (authenticated) |
| Config | `irr_config.yaml` — defines columns, vocabulary, coder assignments |
| CSV handling | PapaParse |
| IRR analysis | External R script (separate pipeline) |

---

## Architecture

The app is a static single-page application. There is no application server.

**Authentication** is handled via GitHub OAuth. A stateless Cloudflare Worker acts as the OAuth proxy — it exchanges the authorization code for an access token server-side, keeping the OAuth client secret out of the browser. The Worker also intermediates all write operations, validating that the authenticated user is authorized to write to the requested resource before forwarding the request.

**Configuration** is driven entirely by `irr_config.yaml`. This file defines the columns to be coded, their types (controlled vocabulary or free text), valid values for each controlled-vocabulary column, coder pair assignments, and the IRR threshold. The app reads this config at startup and renders a coding interface tailored to the project — no code changes are needed to adapt it to a new dataset.

**Data access** is authenticated. Coders access only the sample assigned to them. Data is fetched at session start and is not persisted beyond the local draft cache (localStorage). On submission, the coded file is written back via the Worker.

**Draft state** is stored in `localStorage` keyed by coder name and sample ID. Drafts are cleared on submission. No coder data is transmitted except at the moment of submission.

---

## Configuration

The app is configured via `irr_config.yaml`. Key fields:

```yaml
project: "Project name"
irr_threshold: 90             # Required percent-agreement to proceed

id_column: IncidentID         # Primary key column

ground_truth_fields:          # Source fields — never overwritten by coding
  - IncidentID
  - Date
  - State
  - Cityorcounty

key_columns:                  # Required fields — must all be set before submission
  - name: Status2
    type: controlled_vocab
    values: [Fatal, Non-fatal, Unknown]
  # ...

supplementary_columns:        # Optional fields included in the coded output
  - name: rank
    type: free_text
  # ...

samples:
  - id: 1
    label: "Sample 1"
    coder_a: "Coder Name"
    coder_b: "Coder Name"
    coder_a_github: github_username   # Phase 2
    coder_b_github: github_username   # Phase 2

file_pattern: "irr_sample_{id}_coder{ab}.csv"
```

---

## Project structure

```
pfie-coding-app/
├── public/
│   └── irr_config.yaml              # Project config (column defs, coder assignments)
├── src/
│   ├── App.jsx                      # Top-level state machine: Login → CodingView
│   ├── App.css
│   ├── components/
│   │   ├── Login.jsx                # Auth entry point
│   │   ├── SampleTable.jsx          # Main coding UI — incident navigation, overview
│   │   ├── CodingRow.jsx            # Per-case card: source fields + coded fields
│   │   ├── IncidentOverview.jsx     # Right-drawer overview table (sortable, filterable)
│   │   └── NewIncidentForm.jsx      # Form for adding a case with no source record
│   ├── hooks/
│   │   ├── useConfig.js             # Fetches and parses irr_config.yaml
│   │   ├── useCoderSession.js       # Resolves coder → assigned sample + file URL
│   │   └── useSampleData.js         # Loads CSV, merges draft, exposes save/submit
│   └── lib/
│       ├── config.js                # YAML → normalized config object
│       ├── csv.js                   # PapaParse wrappers: parse, serialize, download
│       └── storage.js               # localStorage draft persistence
├── index.html
├── vite.config.js
└── package.json
```

---

## Use case

Built for a study of fatal and nonfatal firearm assaults on U.S. police officers using data from the [Gun Violence Archive](https://www.gunviolencearchive.org/). Four coder pairs independently code IRR samples across key classification variables before proceeding to full dataset coding.
