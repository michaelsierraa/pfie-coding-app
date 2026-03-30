/**
 * Resolves a coder's sample assignment from the config.
 *
 * Phase 1: fileUrl points to local public/mock_data/ file.
 * Phase 2: fileUrl will be replaced by a GitHub Contents API path.
 *
 * @param {string|null} coderName - Selected coder display name
 * @param {object|null} config - Parsed config object from useConfig
 * @returns {{ sampleId, role, label, partnerName, fileUrl } | null}
 */
export function useCoderSession(coderName, config) {
  if (!coderName || !config) return null

  const assignment = config.getCoderAssignment(coderName)
  if (!assignment) return null

  const { sampleId, role, label, partnerName } = assignment
  const filename = config.getFilePattern(sampleId, role)

  return {
    sampleId,
    role,
    label,
    partnerName,
    filename,
    // Phase 1: local mock data path
    fileUrl: `/mock_data/${filename}`,
  }
}
