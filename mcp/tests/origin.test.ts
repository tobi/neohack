import { test, expect } from "bun:test";
import { hostAllowed, originAllowed } from "../src/origin";
test("local data is not exposed to a rebound hostname, even if Origin matches it", () => {
  const old = process.env.MCP_ALLOWED_ORIGINS;
  delete process.env.MCP_ALLOWED_ORIGINS;
  try {
    expect(hostAllowed(new Request("http://attacker.example:3000/runs"))).toBe(
      false,
    );
    expect(
      originAllowed(
        new Request("http://attacker.example:3000/mcp", {
          headers: { origin: "http://attacker.example:3000" },
        }),
      ),
    ).toBe(false);
    expect(
      originAllowed(
        new Request("http://127.0.0.1:3000/mcp", {
          headers: { origin: "http://attacker.example" },
        }),
      ),
    ).toBe(false);
    expect(
      originAllowed(
        new Request("http://127.0.0.1:3000/mcp", {
          headers: { origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).toBe(true);
    expect(originAllowed(new Request("http://localhost:3000/mcp"))).toBe(true);
    process.env.MCP_ALLOWED_ORIGINS = "https://nethack.example";
    expect(
      originAllowed(
        new Request("http://nethack.example/mcp", {
          headers: { origin: "https://nethack.example" },
        }),
      ),
    ).toBe(true);
  } finally {
    if (old === undefined) delete process.env.MCP_ALLOWED_ORIGINS;
    else process.env.MCP_ALLOWED_ORIGINS = old;
  }
});
