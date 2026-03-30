import yaml from 'js-yaml'

/**
 * Parse irr_config.yaml text into a normalized config object.
 * This is the single source of truth for all column names, vocab values,
 * coder assignments, and file path patterns. No other file imports these
 * directly from the YAML.
 */
export function parseConfig(yamlText) {
  const raw = yaml.load(yamlText)

  // ── Columns ──────────────────────────────────────────────────────────────

  const keyColumns = (raw.key_columns || []).map(col => ({
    name: col.name,
    type: col.type,
    values: col.values ?? null,
    isKey: true,
    notes: col.notes ?? null,
  }))

  const supplementaryColumns = (raw.supplementary_columns || []).map(col => ({
    name: col.name,
    type: col.type,
    values: col.values ?? null,
    isKey: false,
    notes: col.notes ?? null,
  }))

  const allColumns = [...keyColumns, ...supplementaryColumns]

  // ── Coder map ─────────────────────────────────────────────────────────────
  // Maps display name → { sampleId, role, label, partnerName, githubUsername }
  // Phase 1: githubUsername is null (not in YAML yet)

  const coderMap = {}

  for (const sample of raw.samples || []) {
    const sampleId = sample.id
    const label = sample.label || `Sample ${sampleId}`

    const coderA = sample.coder_a
    const coderB = sample.coder_b
    const githubA = sample.coder_a_github ?? null
    const githubB = sample.coder_b_github ?? null

    if (coderA) {
      coderMap[coderA] = {
        sampleId,
        role: 'a',
        label,
        partnerName: coderB ?? null,
        githubUsername: githubA,
      }
    }
    if (coderB) {
      coderMap[coderB] = {
        sampleId,
        role: 'b',
        label,
        partnerName: coderA ?? null,
        githubUsername: githubB,
      }
    }
  }

  // ── File pattern resolver ─────────────────────────────────────────────────
  // Pattern: "irr_sample_{id}_coder{ab}.csv"
  // {id} → sampleId, {ab} → role letter ("a" or "b")

  const filePattern = raw.file_pattern || 'irr_sample_{id}_coder{ab}.csv'

  function getFilePattern(sampleId, role) {
    return filePattern
      .replace('{id}', sampleId)
      .replace('{ab}', role)
  }

  // ── Assignment lookup ─────────────────────────────────────────────────────

  function getCoderAssignment(coderName) {
    return coderMap[coderName] ?? null
  }

  // ── GitHub username lookup ────────────────────────────────────────────────
  // Phase 2: finds a coder by their GitHub username

  function getCoderByGithub(githubLogin) {
    for (const [name, info] of Object.entries(coderMap)) {
      if (info.githubUsername === githubLogin) {
        return { name, ...info }
      }
    }
    return null
  }

  // ── Phase 2 validation ────────────────────────────────────────────────────
  // Warn if github_username fields are partially filled (some present, some missing).
  // In Phase 1 all are null, so this is a no-op.

  const hasAnyGithubUsernames = Object.values(coderMap).some(c => c.githubUsername !== null)
  if (hasAnyGithubUsernames) {
    const missing = Object.entries(coderMap)
      .filter(([, c]) => !c.githubUsername)
      .map(([name]) => name)
    if (missing.length > 0) {
      console.error(
        '[config] Missing github_username for coders:',
        missing.join(', '),
        '— Phase 2 identity mapping will fail for these users.'
      )
    }
  }

  return {
    project: raw.project ?? '',
    irr_threshold: raw.irr_threshold ?? 90,
    groundTruthFields: raw.ground_truth_fields || [],
    idColumn: raw.id_column || 'IncidentID',
    keyColumns,
    supplementaryColumns,
    allColumns,
    coderMap,
    samples: raw.samples || [],
    codedSamplesDir: raw.coded_samples_dir || 'data/irr/irr_coded_samples',
    getFilePattern,
    getCoderAssignment,
    getCoderByGithub,
  }
}
