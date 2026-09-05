import { mkdtemp, rm, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NativeTransport } from '../dist/typescript/native.js';
import { Neonethack } from '../dist/typescript/client.js';
export const root = resolve(import.meta.dirname, '..');
export const identity = { name: 'Contract', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
const owners = new WeakMap();
const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile(`${root}/protocol/response.schema.json`, 'utf8')));
export function checked(transport) {
  const send = transport.send.bind(transport);
  transport.send = async request => {
    const result = await send(request);
    assert.ok(validate(result), JSON.stringify(validate.errors));
    return result;
  };
  return transport;
}
export async function fixture(t, options = {}) {
  const sessions = options.sessions ?? await mkdtemp(`${tmpdir()}/neonethack-test-`);
  const transport = new NativeTransport({ executable: options.executable ?? process.env.NEONETHACK_EXECUTABLE ?? `${root}/build/native/neonethack`, enginePath: options.enginePath ?? `${root}/engine/playground/nethack`, dataPath: options.dataPath ?? `${root}/engine/playground`, sessionsPath: sessions });
  let owner = owners.get(t);
  if (!owner) {
    owner = { transports: [], stores: new Set() }; owners.set(t, owner);
    t.after(async () => {
      await Promise.all(owner.transports.map(transport => transport.close()));
      for (const store of owner.stores) await rm(store, { recursive: true, force: true });
    });
  }
  owner.transports.push(transport);
  if (!options.sessions) owner.stores.add(sessions);
  checked(transport);
  return { sessions, transport, api: new Neonethack(transport) };
}
