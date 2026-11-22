// `meta eject docs-site --force` over files that already hold the shipped bytes writes
// nothing: --force replaces what differs, it does not churn what does not.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectDocsSite } from "../../src/lib/docs-site-eject.js";

const made: string[] = [];
afterEach(async () => { while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true }); });

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]).sort();

describe("ejectDocsSite --force", () => {
  test("rewrites only the file that differs from the shipped copy", async () => {
    const root = mkdtempSync(join(process.env.DEV_SCRATCH || tmpdir(), "docs-site-eject-force-"));
    made.push(root);
    const first = await ejectDocsSite(root, false);
    expect(first.every((f) => f.status === "created")).toBe(true);

    const all = filesUnder(join(root, "codegen", "docs-site"));
    const edited = join(root, first[0]!.path);
    writeFileSync(edited, "/* owned */\n", "utf8");
    const before = new Map(all.map((f) => [f, statSync(f).mtimeMs]));
    await new Promise((r) => setTimeout(r, 20));

    const forced = await ejectDocsSite(root, true);
    expect(forced.filter((f) => f.status === "replaced").map((f) => f.path)).toEqual([first[0]!.path]);
    expect(forced.filter((f) => f.status !== "replaced").every((f) => f.status === "preserved" && f.identical === true)).toBe(true);
    for (const f of all) {
      if (f === edited) expect(statSync(f).mtimeMs).not.toBe(before.get(f)!);
      else expect(statSync(f).mtimeMs).toBe(before.get(f)!);
    }
  });
});
