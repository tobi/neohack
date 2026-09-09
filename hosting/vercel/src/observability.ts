// Only route templates and bounded operational fields reach application logs.
// Vercel supplies invocation/deployment correlation; never log Request objects,
// URLs, headers, storage paths, raw exceptions, journals or account identifiers.
export function routeName(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.has('__path')
    ? '/api/' + url.searchParams.get('__path') : url.pathname;
  if (/^\/api\/vaults\/[^/]+\/adventures$/.test(path)) return '/api/vaults/:vault/adventures';
  if (/^\/api\/vaults\/[^/]+$/.test(path)) return '/api/vaults/:vault';
  if (/^\/api\/runs\/[^/]+\/replay$/.test(path)) return '/api/runs/:run/replay';
  if (/^\/api\/runs\/[^/]+\/inputs$/.test(path)) return '/api/runs/:run/inputs';
  if (/^\/api\/runs\/[^/]+\/checkpoint$/.test(path)) return '/api/runs/:run/checkpoint';
  if (/^\/api\/runs\/[^/]+\/chronicle$/.test(path)) return '/api/runs/:run/chronicle';
  if (/^\/api\/runs\/[^/]+$/.test(path)) return '/api/runs/:run';
  if (path.startsWith('/api/account/')) return '/api/account/*';
  return ['/api/account', '/api/health', '/api/stats', '/api/runs', '/api/errors'].includes(path) ? path : 'unmatched';
}
export type Failure = { code?: 'storage_unconfigured' | 'storage_unavailable'; kind?: string };
export function failureKind(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'BlobAccessError', 'BlobStoreSuspendedError', 'BlobServiceNotAvailable', 'BlobUnknownError'].includes(name) ? name : 'Error';
}
export function logFailure(request: Request, status: number, started: number, failure: Failure) {
  if(status>=400&&status<500&&['/api/runs/:run/inputs','/api/runs/:run/checkpoint'].includes(routeName(request)))console.warn(JSON.stringify({event:'recording_upload_refused',route:routeName(request),method:request.method,status}));
  if (status < 500) return;
  console.error(JSON.stringify({
    event: 'request_failed', route: routeName(request),
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER',
    status, durationMs: Math.max(0, Math.round(performance.now() - started)),
    code: failure.code ?? 'service_unavailable', kind: failure.kind,
  }));
}
