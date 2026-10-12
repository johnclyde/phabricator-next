/** Exact model URL lookup. A miss is an HTTP-like failure in memory, never a request to any server. */
export function transcriptionAssetResponse(files: ReadonlyMap<string, ArrayBuffer>, modelBaseUrl: string, request: string): Response {
  let path: string | null = null;
  // The loader asks for localModelPath + modelId + filename; remote aliases are deliberately unsupported.
  if (request.startsWith(modelBaseUrl)) path = request.slice(modelBaseUrl.length);
  const data = path === null ? undefined : files.get(path);
  return data === undefined ? new Response(null, { status: 404 }) : new Response(data, { status: 200, headers: { 'Content-Length': String(data.byteLength) } });
}
