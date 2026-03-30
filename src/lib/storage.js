/**
 * localStorage-backed draft persistence.
 *
 * Draft key:     draft__{coderName}__{sampleId}
 * Submitted key: submitted__{coderName}__{sampleId}
 *
 * Edge cases:
 * - Stale draft after submission: loadDraft returns null if already submitted,
 *   forcing a clean reload from the source CSV.
 * - Concurrent tabs: last-write-wins. Acceptable because each coder owns exactly
 *   one file and concurrent editing from two tabs is unlikely.
 */

function draftKey(coderName, sampleId) {
  return `draft__${coderName}__${sampleId}`
}

function submittedKey(coderName, sampleId) {
  return `submitted__${coderName}__${sampleId}`
}

/**
 * Save the current coding draft to localStorage.
 *
 * @param {string} coderName
 * @param {number} sampleId
 * @param {object[]} rows - Current row state (includes coded field values)
 */
export function saveDraft(coderName, sampleId, rows) {
  try {
    localStorage.setItem(draftKey(coderName, sampleId), JSON.stringify(rows))
  } catch (e) {
    console.warn('[storage] Failed to save draft:', e)
  }
}

/**
 * Load a coding draft from localStorage.
 * Returns null if no draft exists OR if the coder has already submitted
 * (to prevent stale pre-submission drafts from appearing after submission).
 *
 * @param {string} coderName
 * @param {number} sampleId
 * @returns {object[]|null}
 */
export function loadDraft(coderName, sampleId) {
  if (isSubmitted(coderName, sampleId)) return null
  try {
    const raw = localStorage.getItem(draftKey(coderName, sampleId))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    console.warn('[storage] Failed to load draft:', e)
    return null
  }
}

/**
 * Mark a coder's sample as submitted.
 * After this, loadDraft will always return null for this coder+sample pair.
 *
 * @param {string} coderName
 * @param {number} sampleId
 */
export function markSubmitted(coderName, sampleId) {
  try {
    localStorage.setItem(submittedKey(coderName, sampleId), new Date().toISOString())
  } catch (e) {
    console.warn('[storage] Failed to mark submitted:', e)
  }
}

/**
 * Check whether a coder has submitted their sample.
 *
 * @param {string} coderName
 * @param {number} sampleId
 * @returns {boolean}
 */
export function isSubmitted(coderName, sampleId) {
  return localStorage.getItem(submittedKey(coderName, sampleId)) !== null
}

/**
 * Clear the draft for a coder+sample pair (does not affect submitted status).
 *
 * @param {string} coderName
 * @param {number} sampleId
 */
export function clearDraft(coderName, sampleId) {
  localStorage.removeItem(draftKey(coderName, sampleId))
}
