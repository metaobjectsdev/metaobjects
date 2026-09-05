// `meta verify --docs` — the docs-drift gate, end to end against a real project.
//
// It is exercised here rather than as a unit test because the whole point of the gate is
// that it runs THE DOCS COMMAND: a unit test over a stubbed docs run would prove the diff
// logic and nothing about whether the gate and the door agree. This also exercises the
// `agent/schema.md` surface against a REAL expected-schema snapshot from migrate-ts —
// the one thing the codegen-ts unit tests deliberately cannot reach.
//
// THE GATE IS SHOWN TO FAIL, three ways, and shown NOT to fail on a hand-written file. A
// gate committed green-only proves that it ran, not that it can convict.

import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

// test/integration/ -> cli -> packages -> typescript -> server -> repo root
const SHOWCASE = resolve(import.meta.dirname, "../../../../../../examples/showcase");

/** A throwaway copy of the showcase with a freshly generated docs tree. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-docs-"));
  cpSync(SHOWCASE, dir, { recursive: true });
  return dir;
}

async function generateDocs(dir: string): Promise<void> {
  expect(await run(["docs", dir, "--out", join(dir, "docs")])).toBe(0);
}

describe("meta verify --docs", () => {
  test("a freshly generated docs tree is clean, and it includes the agent surface", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The agent surface materialises only with a loadable gen config, which the
      // showcase has. Assert the pages exist before asserting the gate is green, so a
      // green result cannot come from the surface having silently emitted nothing.
      expect(existsSync(join(dir, "docs", "agent", "schema.md"))).toBe(true);
      expect(existsSync(join(dir, "docs", "agent", "ui.md"))).toBe(true);
      expect(existsSync(join(dir, "docs", "agent", "requirements.md"))).toBe(true);
      // Built from the REAL migrate-ts snapshot: the dialect comes from the project's
      // own config, not from `meta docs`'s neutral "sqlite" placeholder.
      const schema = readFileSync(join(dir, "docs", "agent", "schema.md"), "utf8");
      expect(schema).toContain("`subscribers`");
      expect(schema).toContain("Declared by `acme::Subscriber`.");

      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a committed page's content no longer matches the model", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      const page = join(dir, "docs", "agent", "schema.md");
      writeFileSync(page, readFileSync(page, "utf8").replace("subscribers", "subscribersRENAMED"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a page a fresh run emits was never committed", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      rmSync(join(dir, "docs", "agent", "ui.md"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when the MODEL moved and nobody re-ran `meta docs`", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The real drift this gate exists for: the metadata changes, the committed pages
      // keep describing the previous model, and every other gate stays green.
      const meta = join(dir, "metaobjects", "meta.subscriber.yaml");
      writeFileSync(meta, readFileSync(meta, "utf8").replace("name: name", "name: fullName"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fail on a hand-written file sitting in the docs directory", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // `docs.outDir` defaults to `./docs`, which in a real repository is full of
      // hand-written documentation. Convicting those is the jurisdiction mistake
      // `verify --codegen`'s orphan branch was corrected for; with no manifest to appeal
      // to, this gate must never make it.
      writeFileSync(join(dir, "docs", "ARCHITECTURE.md"), "# Ours, not MetaObjects'.\n");
      // Inside `agent/` too: the gate convicts a STALE GENERATED page there, and it tells
      // the two apart by the `@generated` marker rather than by the directory alone.
      writeFileSync(join(dir, "docs", "agent", "NOTES.md"), "# Also ours.\n");
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a generated `agent/` page is committed that a fresh run no longer emits", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The case this gate was silent on: `meta docs` SKIPS `agent/schema.md` (rather than
      // failing) when the expected schema cannot be built or no dialect is declared, so a
      // committed page describing the previous schema survived the diff — the fresh run
      // produced no counterpart to compare it against. That is the change the gate most
      // needs to flag, and it passed on it.
      //
      // Simulated by copying a generated page to a name no run emits: same shape, one
      // condition — a committed file carrying our marker that a fresh run does not
      // produce — without needing to break the project to reach it.
      const stale = readFileSync(join(dir, "docs", "agent", "schema.md"), "utf8");
      writeFileSync(join(dir, "docs", "agent", "schema.postgres.md"), stale);
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 2 (a configuration problem, not drift) with no gen config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-docs-noconfig-"));
    try {
      cpSync(join(SHOWCASE, "metaobjects"), join(dir, "metaobjects"), { recursive: true });
      cpSync(join(SHOWCASE, ".metaobjects", "config.json"),
             join(dir, ".metaobjects", "config.json"), { recursive: true });
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
