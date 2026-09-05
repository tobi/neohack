export async function bytes(url) {
  if (url.protocol === 'file:' && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(url);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const response = await fetch(url);
  if (!response.ok) throw Error(`Cannot load ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}
export async function checked(base, name, manifest) {
  const data = await bytes(new URL(name, base));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.files[name]) throw Error(`WASM package integrity mismatch: ${name}`);
  return data;
}
export async function loadManifest(base) {
  const manifest = JSON.parse(new TextDecoder().decode(await bytes(new URL('manifest.json', base))));
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.buildId) || !manifest.files || typeof manifest.files !== 'object') throw Error('Unsupported WASM manifest');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(manifest.files))))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.buildId) throw Error('Invalid WASM build identity');
  return manifest;
}
