/** Optional browser-native compression; old browsers retain ordinary JSON requests. */
export async function jsonRequest(value: unknown): Promise<{ headers: Record<string, string>; body: BodyInit }> {
  // Text JSON can compress better than base64 Float64 lanes; packing is a separate opt-in.
  const text = JSON.stringify(value);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (text.length < 256 * 1024 || typeof CompressionStream === 'undefined') return { headers, body: text };
  const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  headers['content-encoding'] = 'gzip'; return { headers, body: compressed };
}
