import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSite } from "../src/site";

const GOLDEN = join(import.meta.dir, "fixture/golden");
const walk = (d: string, base = d): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e); return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
});

test("fixture site is byte-identical to the committed golden", async () => {
  const out = mkdtempSync(join(tmpdir(), "golden-"));
  await generateSite({ sourceDirs: [join(import.meta.dir, "fixture/input/acme")], outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234" });
  const got = walk(out).sort(); const want = walk(GOLDEN).sort();
  expect(got).toEqual(want);
  for (const f of want) expect(readFileSync(join(out, f), "utf8")).toBe(readFileSync(join(GOLDEN, f), "utf8"));
});
