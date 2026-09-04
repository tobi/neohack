// Transport framing only, not game semantics. JSON.parse otherwise silently
// accepts the last duplicate key, losing ambiguity before the C core sees it.
export const MAX_WIRE_BYTES = 64 * 1024;
export function parseWireJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_WIRE_BYTES)
    throw Error("JSON frame too large");
  const value = JSON.parse(text); // Establish lexical validity before scanning.
  let p = 0;
  const ws = () => {
    while (/\s/.test(text[p] ?? "") && p < text.length) p++;
  };
  const string = () => {
    const start = p++;
    while (text[p] !== '"') {
      if (text[p] === "\\") p++;
      p++;
    }
    p++;
    return text.slice(start, p);
  };
  const scan = (depth: number) => {
    if (depth > 64) throw Error("JSON nesting limit exceeded");
    ws();
    if (text[p] === "{") {
      p++;
      ws();
      const keys = new Set<string>();
      if (text[p] !== "}")
        for (;;) {
          ws();
          const key = JSON.parse(string());
          if (keys.has(key)) throw Error("Duplicate JSON field");
          keys.add(key);
          ws();
          p++;
          scan(depth + 1);
          ws();
          if (text[p] === "}") break;
          p++;
        }
      p++;
    } else if (text[p] === "[") {
      p++;
      ws();
      if (text[p] !== "]")
        for (;;) {
          scan(depth + 1);
          ws();
          if (text[p] === "]") break;
          p++;
        }
      p++;
    } else if (text[p] === '"') string();
    else while (p < text.length && !/[\s,}\]]/.test(text[p])) p++;
  };
  scan(0);
  return value;
}
