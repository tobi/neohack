const PLAYER = "neohack-player";
let generatedPlayer: string | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requestedRun() {
  const values = new URLSearchParams(location.hash.slice(1));
  const id = values.get("run"), vault = values.get("vault");
  if (!id && !vault) return null;
  if (!id || !vault || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !UUID.test(vault)) throw Error("This adventure link is incomplete or invalid.");
  return { id, vault };
}
export function showRunUrl(id: string, vault = playerId()) {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ run: id, vault }).toString();
  history.replaceState(null, "", url);
}
export function clearRunUrl() {
  const url = new URL(location.href); url.hash = "";
  history.replaceState(null, "", url);
}


export type CloudAdventure = {
  buildId?: string;
  id: string;
  name: string;
  role: string;
  seed?: number;
  turn: number;
  ended: boolean;
};

export function playerId() {
  try { const linked = requestedRun(); if (linked) return linked.vault; } catch { /* The mounted page reports invalid links. */ }
  let id = localStorage.getItem(PLAYER);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = generatedPlayer ??= crypto.randomUUID();
  }
  return id;
}

export function rememberPlayer(id: string) { if (!localStorage.getItem(PLAYER)) localStorage.setItem(PLAYER, id); }

export function journalUrl(vault = playerId()) {
  return new URL(`/api/vaults/${vault}`, location.href).href;
}

export async function cloudReady() {
  try {
    const response = await fetch("/api/health");
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

export async function restoreAdventures(vault = playerId()) {
  const response = await fetch(`/api/vaults/${vault}/adventures`);
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!Array.isArray(data)) return null;
  return data as CloudAdventure[];
}

let publication: Promise<void> = Promise.resolve();
const published = new Map<string, string>();
export function publishCloud(saves: CloudAdventure[], vault = playerId()) {
  const copy = structuredClone(saves);
  const next = publication.then(() => writeCloud(copy, vault));
  publication = next.catch(() => {});
  return next;
}
async function writeCloud(saves: CloudAdventure[], vault: string) {
  const serialized = JSON.stringify(saves);
  if (published.get(vault) === serialized) return;
  const headers = { "content-type": "application/json" };
  const publicRuns = saves.map(({ id, name, role, turn, ended }) => ({
    id,
    name,
    role,
    turn,
    ended,
  }));
  const responses = await Promise.all([
    fetch(`/api/vaults/${vault}/adventures`, {
      method: "PUT",
      headers,
      body: serialized,
    }),
    fetch("/api/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ runs: publicRuns }),
    }),
  ]);
  if (responses.some(response => !response.ok)) throw Error("Cloud adventure metadata was not saved.");
  published.set(vault, serialized);
}
