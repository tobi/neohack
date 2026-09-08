import { listen, send } from "./worker-port.mjs";
import { encodeCheckpoint } from "./checkpoint-codec.mjs";
listen(async (message) => {
  try {
    const value = await encodeCheckpoint(message.value);
    send({ id: message.id, value }, [value.bytes.buffer]);
  } catch (error) {
    send({ id: message.id, error: String(error) });
  }
});
