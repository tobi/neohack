// Public-perception replay. Deliberately has no World/engine dependency.
// Version 1 records an authoritative checkpoint plus public events at each
// interaction boundary, including decisions and zero-turn actions.
export const RECORDING_FORMAT = "neonethack.perception";
export const RECORDING_VERSION = 1;

export function validateFrame(frame) {
  if (frame?.format !== RECORDING_FORMAT || frame.version !== RECORDING_VERSION)
    throw new Error(
      "Unsupported recording format/version. Engine input logs are not perception recordings.",
    );
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0)
    throw new Error("Invalid frame sequence");
  const r = frame.response,
    o = r?.observation;
  if (
    !r ||
    !o ||
    !Array.isArray(o.world) ||
    !Array.isArray(o.inventory) ||
    !Array.isArray(r.events)
  )
    throw new Error("Incomplete perception frame");
  if (o.world.length > 20000)
    throw new Error("Perception frame exceeds supported map size");
  return frame;
}

export function observationAt(frame) {
  validateFrame(frame);
  // Renderers can animate their own copies without changing archived frames.
  return structuredClone(frame.response);
}

export function parseRecording(text) {
  const frames = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let frame;
    try {
      frame = validateFrame(JSON.parse(line));
    } catch (e) {
      throw new Error(`Recording line ${frames.length + 1}: ${e.message}`);
    }
    if (frame.sequence !== frames.length)
      throw new Error("Recording contains a sequence gap or duplicate");
    frames.push(frame);
  }
  if (!frames.length) throw new Error("Recording is empty");
  return frames;
}

export class LocalRecording {
  constructor(frames) {
    this.frames = frames.map(validateFrame);
    this.index = frames.map((f) => ({
      sequence: f.sequence,
      turn: f.response.observation.turn,
      revision: f.response.revision,
    }));
  }
  async frame(sequence) {
    if (
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence >= this.frames.length
    )
      throw new RangeError("Frame outside recording");
    return this.frames[sequence];
  }
}

export class RemoteRecording {
  constructor(id, request = fetch) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new Error("Invalid recording id");
    this.id = id;
    this.request = (...args) => request(...args);
    this.index = [];
    this.pages = new Map();
    this.pageSize = 20;
  }
  async open() {
    const r = await this.request(`/runs/${this.id}/index`);
    if (!r.ok) throw new Error(`Cannot read recording index (${r.status})`);
    const d = await r.json();
    if (d.version !== 1 || !Array.isArray(d.frames))
      throw new Error("Unsupported recording index");
    this.index = d.frames;
    return this;
  }
  async frame(sequence) {
    if (
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence >= this.index.length
    )
      throw new RangeError("Frame outside recording");
    const page = Math.floor(sequence / this.pageSize) * this.pageSize;
    if (!this.pages.has(page)) {
      const request = (async () => {
        const r = await this.request(
          `/runs/${this.id}/frames?from=${page}&limit=${this.pageSize}`,
        );
        if (!r.ok)
          throw new Error(`Cannot read recording frames (${r.status})`);
        const data = await r.json();
        if (data.version !== 1 || !Array.isArray(data.frames))
          throw new Error("Unsupported recording page");
        data.frames.forEach((f, i) => {
          validateFrame(f);
          if (f.sequence !== page + i)
            throw new Error("Recording page contains a sequence gap");
        });
        return data.frames;
      })();
      this.pages.set(page, request);
      request.catch(() => this.pages.delete(page));
      // Bounded cache; long-run review does not retain every full observation.
      while (this.pages.size > 6)
        this.pages.delete(this.pages.keys().next().value);
    }
    const frames = await this.pages.get(page);
    const frame = frames[sequence - page];
    if (!frame) throw new Error("Recording changed or page is incomplete");
    return frame;
  }
}
