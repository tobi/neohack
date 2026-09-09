/** Public replay identities never contain save links or account credentials. */
export const validReplayId = (id: string) => /^[\w-]{1,64}$/.test(id);
export function replayPage(id: string, origin: string) {
  if (!validReplayId(id)) throw Error('Invalid replay ID');
  return new URL('/replays/' + encodeURIComponent(id), origin).href;
}
export function replayIdentity(source: string, base: string, site: string) {
  const url = new URL(source, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  const page = url.pathname.match(/^\/replays\/([\w-]{1,64})\/?$/);
  const manifest = url.pathname.match(/\/replays\/([\w-]{1,64})\/manifest(?:-[a-f0-9]+)?\.json$/);
  const api = url.pathname.match(/^\/api\/runs\/([\w-]{1,64})\/replay$/);
  const id = page?.[1] ?? manifest?.[1] ?? api?.[1] ?? (url.pathname === '/dashboard' ? url.searchParams.get('run') : null);
  if (id && validReplayId(id)) return {id, href: replayPage(id, page || api || url.pathname === '/dashboard' ? url.origin : site)};
}
