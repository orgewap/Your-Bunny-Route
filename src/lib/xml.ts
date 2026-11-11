/** DOM XMLSerializer can preserve the source document's XML declaration.
 * Keep exactly one declaration so SUMO/netconvert can read the exported OSM. */
export function serializeOsmDocument(serialized: string): string {
  const body = serialized.replace(/^\uFEFF?\s*<\?xml\b[^>]*\?>\s*/i, '').trimEnd()
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + '\n'
}
