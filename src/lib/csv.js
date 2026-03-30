import Papa from 'papaparse'

/**
 * Parse CSV text into an array of row objects.
 * Uses Papa Parse to correctly handle multiline fields (Incidentcharacteristics, Sources).
 *
 * @param {string} text - Raw CSV text
 * @returns {object[]} Array of row objects keyed by header names
 */
export function parseCSV(text) {
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    // Do not transform values — preserve 'NA', '0', '1' as-is
    dynamicTyping: false,
  })

  if (result.errors.length > 0) {
    const serious = result.errors.filter(e => e.type !== 'Delimiter')
    if (serious.length > 0) {
      console.warn('[csv] Parse warnings:', serious)
    }
  }

  return result.data
}

/**
 * Get the column order from the first row of parsed data.
 * Must be called immediately after parseCSV to capture the original column order.
 *
 * @param {string} text - Raw CSV text (same text passed to parseCSV)
 * @returns {string[]} Column names in original order
 */
export function getColumnOrder(text) {
  const result = Papa.parse(text, { header: false, preview: 1 })
  return result.data[0] ?? []
}

/**
 * Serialize rows back to CSV string, preserving the original column order.
 * Papa Parse's unparse() correctly quotes multiline values and handles
 * all the quoting edge cases that a hand-rolled serializer would not.
 *
 * @param {object[]} rows - Array of row objects
 * @param {string[]} columnOrder - Column names in desired output order
 * @returns {string} CSV string
 */
export function serializeCSV(rows, columnOrder) {
  return Papa.unparse(rows, {
    columns: columnOrder,
    quotes: false,       // Let Papa decide quoting (quotes fields containing commas/newlines)
    newline: '\n',       // Unix line endings (matches R's default read.csv behavior)
  })
}

/**
 * Trigger a CSV file download in the browser.
 *
 * @param {string} filename - File name for the download
 * @param {string} csvString - CSV content
 */
export function downloadCSV(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
