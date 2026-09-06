import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Neonethack } from "./client.js";
import { NativeTransport, type NativeOptions } from "./native.js";
export * from "./client.js";
export type { NativeOptions } from "./native.js";

/** Native NetHack with package-relative engine defaults and a local sessions directory. */
export default class Nethack extends Neonethack {
  constructor(options: Partial<NativeOptions> = {}) {
    const library = fileURLToPath(new URL("../../", import.meta.url));
    super(new NativeTransport({
      executable: resolve(library, "build/native/neonethack"),
      enginePath: resolve(library, "engine/playground/nethack"),
      dataPath: resolve(library, "engine/playground"),
      sessionsPath: resolve("sessions"),
      ...options,
    }));
  }
}
