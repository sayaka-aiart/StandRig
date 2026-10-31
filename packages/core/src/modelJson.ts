/** Small files stay readable; dense keyforms must not expand past V8's string limit. */
export const MODEL_PRETTY_PRINT_LIMIT = 8 * 1024 * 1024;

export function stringifyModelDocument(value: unknown): string {
  const compact = JSON.stringify(value);
  if (compact === undefined) throw new TypeError("Model document is not JSON serializable");
  return compact.length > MODEL_PRETTY_PRINT_LIMIT ? compact : JSON.stringify(value, null, 2);
}
