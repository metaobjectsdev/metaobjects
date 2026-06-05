import { describe, expect, test } from "bun:test";
import { systemClock, uuidIds, type LlmClient } from "../src/client.js";

describe("client seam", () => {
  test("systemClock returns a number", () => {
    expect(typeof systemClock.now()).toBe("number");
  });

  test("uuidIds.next returns distinct uuid-shaped strings", () => {
    const a = uuidIds.next();
    const b = uuidIds.next();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("LlmClient is structurally satisfiable", async () => {
    const client: LlmClient = {
      async complete(req) {
        return { body: `echo:${req.prompt}`, model: req.model };
      },
    };
    const out = await client.complete({ prompt: "hi", model: "m" });
    expect(out.body).toBe("echo:hi");
  });
});
