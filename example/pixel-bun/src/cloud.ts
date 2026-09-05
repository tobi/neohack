const PLAYER = "neohack-player";

export type CloudAdventure = {
  id: string;
  name: string;
  role: string;
  seed?: number;
  turn: number;
  ended: boolean;
};

export function playerId() {
  let id = localStorage.getItem(PLAYER);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER, id);
  }
  return id;
}

export function journalUrl() {
  return new URL(`/api/vaults/${playerId()}`, location.href).href;
}

export async function cloudReady() {
  try {
    const response = await fetch("/api/health");
    return response.ok;
  } catch {
    return false;
  }
}

export async function restoreAdventures() {
  const response = await fetch(`/api/vaults/${playerId()}/adventures`);
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!Array.isArray(data)) return null;
  return data as CloudAdventure[];
}

export async function publishCloud(saves: CloudAdventure[]) {
  const headers = { "content-type": "application/json" };
  const publicRuns = saves.map(({ id, name, role, turn, ended }) => ({
    id,
    name,
    role,
    turn,
    ended,
  }));
  await Promise.all([
    fetch(`/api/vaults/${playerId()}/adventures`, {
      method: "PUT",
      headers,
      body: JSON.stringify(saves),
    }),
    fetch("/api/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ runs: publicRuns }),
    }),
  ]);
}
