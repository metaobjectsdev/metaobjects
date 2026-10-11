import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genCommand } from "../src/commands/gen.js";

// ADR-0021 D3 — `meta gen --list` discoverability surface.
//
// `--list` must print the registered generators (stable name + description),
// exit 0, and run NO codegen — in particular it must NOT require a
// metaobjects.config.ts or any metaobjects/ metadata. We run it from an empty
// temp dir to prove that.

let logged: string[];
let erred: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  erred = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { erred.push(a.join(" ")); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

function out(): string {
  return logged.join("\n");
}

describe("meta gen --list (ADR-0021 D3)", () => {
  test("prints registered generators, exits 0, runs no codegen (no config needed)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-gen-list-"));
    try {
      const code = await genCommand(["--list"], tmp);
      expect(code).toBe(0);
      // No "no metaobjects/ found" / load error — codegen did not run.
      expect(erred.join("\n")).not.toContain("no metaobjects/");
      expect(erred.join("\n")).not.toContain("failed to load");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("lists a few stable names with their descriptions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-gen-list-"));
    try {
      await genCommand(["--list"], tmp);
      const text = out();
      for (const name of ["entity", "routes", "render-helper", "extractor", "barrel"]) {
        expect(text, `lists '${name}'`).toContain(name);
      }
      // Each line carries a human description (em-dash separator + words).
      expect(text).toMatch(/entity\s+—\s+\S/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("flags docs neutral (not part of the recommended native suite)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-gen-list-"));
    try {
      await genCommand(["--list"], tmp);
      const text = out();
      // It appears (identity/discoverability) ...
      expect(text).toContain("docs");
      // ... but is clearly marked neutral and points at `meta docs`. The standalone
      // `mermaid-er` generator that sat beside it was removed in 1.1.
      expect(text).not.toContain("mermaid-er");
      expect(text.toLowerCase()).toContain("neutral");
      expect(text).toContain("meta docs");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("says every generator is a reference helper you own (ADR-0034 Amendment 3)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-gen-list-"));
    try {
      await genCommand(["--list"], tmp);
      const text = out();
      expect(text).toContain("reference helper, not a guarantee");
      expect(text).toContain("`meta eject <name>`");
      // An agent whose store or framework is not in this list must learn here that it is a
      // supported path, not a dead end — many never open the skills before deciding.
      expect(text).toContain("references/any-stack.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("marks each generator that ships no reference copy as package-only, and says why", async () => {
    // The note above says `meta eject` copies a generator; for an entry with no
    // reference template that is false, so the row has to say so where it is read.
    const tmp = mkdtempSync(join(tmpdir(), "meta-gen-list-"));
    try {
      await genCommand(["--list"], tmp);
      const text = out();
      const line = (name: string) => text.split("\n").find((l) => l.startsWith(`  ${name} `)) ?? "";
      // The one entry left: the Mustache primitive, where the adopter already supplies
      // the template and there is no emit logic to own (ADR-0034 Amendment 7).
      expect(line("template")).toContain("package-only");
      expect(text.split("\n").filter((l) => l.includes("[package-only]")).length).toBe(1);
      // An ejectable entry is never marked. `callable` and `trace-helper` were marked
      // until they gained reference templates; `shared-model` and the docs tier until
      // Amendment 7.
      expect(line("callable")).not.toContain("package-only");
      expect(line("trace-helper")).not.toContain("package-only");
      expect(line("shared-model")).not.toContain("package-only");
      expect(line("docs")).not.toContain("package-only");
      expect(line("api-docs")).not.toContain("package-only");
      expect(line("prompt-render")).not.toContain("package-only");
      expect(line("entity")).not.toContain("package-only");
      expect(text).toContain("package-only = no reference template ships");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
