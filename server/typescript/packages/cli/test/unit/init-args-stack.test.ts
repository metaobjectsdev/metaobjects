import { test, expect, describe } from "bun:test";
import { parseInitArgs } from "../../src/lib/args.js";

describe("parseInitArgs — stack flags", () => {
  test("repeatable --server / --client and --no-skills", () => {
    const f = parseInitArgs(["--server", "java", "--server", "kotlin", "--client", "react", "--client", "tanstack", "--no-skills"]);
    expect(f.servers).toEqual(["java", "kotlin"]);
    expect(f.clients).toEqual(["react", "tanstack"]);
    expect(f.noSkills).toBe(true);
    expect(f.wireRoot).toBe(false);
  });
  test("defaults: empty server/client overrides, skills on, no root wiring", () => {
    const f = parseInitArgs([]);
    expect(f.servers).toEqual([]);
    expect(f.clients).toEqual([]);
    expect(f.noSkills).toBe(false);
    expect(f.wireRoot).toBe(false);
  });
});
