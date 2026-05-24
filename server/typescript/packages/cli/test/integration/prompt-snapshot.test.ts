import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/index.js";

// A view-object payload (Brief) + two prompts. `greeting` includes a shared
// partial (the load-bearing case: editing the partial drifts the rendered
// prompt while greeting.mustache itself is unchanged).
const META = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.value": { name: "Brief", children: [{ "field.string": { name: "name" } }] } },
      {
        "template.prompt": {
          name: "greeting",
          "@payloadRef": "Brief",
          "@textRef": "prompt/greeting",
          "@format": "text",
        },
      },
      {
        "template.prompt": {
          name: "farewell",
          "@payloadRef": "Brief",
          "@textRef": "prompt/farewell",
          "@format": "text",
        },
      },
    ],
  },
};

function scaffold(): string {
  const tmp = mkdtempSync(join(tmpdir(), "meta-snap-"));
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(META), "utf8");
  mkdirSync(join(tmp, "prompts", "shared"), { recursive: true });
  mkdirSync(join(tmp, "prompts", "prompt"), { recursive: true });
  writeFileSync(join(tmp, "prompts", "shared", "preamble.mustache"), "You are a helpful guide.\n", "utf8");
  writeFileSync(join(tmp, "prompts", "prompt", "greeting.mustache"), "{{> shared/preamble}}Hi {{name}}.", "utf8");
  writeFileSync(join(tmp, "prompts", "prompt", "farewell.mustache"), "Bye {{name}}.", "utf8");
  return tmp;
}

function writePayload(tmp: string, templateName: string, payload: unknown): void {
  const dir = join(tmp, ".metaobjects", "snapshots", templateName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "payload.json"), JSON.stringify(payload), "utf8");
}

const snapPath = (tmp: string, name: string) =>
  join(tmp, ".metaobjects", "snapshots", name, "output.snap");

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta prompt-snapshot (write mode)", () => {
  test("writes output.snap for a template that has a payload", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" });
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(0);
      expect(existsSync(snapPath(tmp, "greeting"))).toBe(true);
      expect(readFileSync(snapPath(tmp, "greeting"), "utf8")).toBe("You are a helpful guide.\nHi Ada.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skips a template that has no payload (no golden written)", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" }); // farewell intentionally has none
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(0);
      expect(existsSync(snapPath(tmp, "farewell"))).toBe(false);
      expect([...out, ...err].join("\n")).toContain("farewell");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 2 when metaobjects/ is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-snap-none-"));
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 when a template's @textRef does not resolve", async () => {
    const tmp = scaffold();
    writePayload(tmp, "farewell", { name: "Ada" }); // not skipped — it has a payload
    rmSync(join(tmp, "prompts", "prompt", "farewell.mustache"), { force: true }); // @textRef now unresolvable
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(1);
      expect([...out, ...err].join("\n")).toContain("farewell");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
