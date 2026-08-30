// The CI injector is the ONLY thing that fills the live site's code blocks, and it
// runs on a Pages workflow nobody watches. These tests pin the two behaviours that
// decide whether a bad deploy is loud or silent — and the asymmetry between them,
// which is a deliberate design decision rather than an oversight.
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const ENTRY = resolve(REPO, "scripts/site-inject-ci.mjs");

/** A throwaway `www/` tree holding one page with the given body. */
function site(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "inject-ci-"));
  for (const [rel, html] of Object.entries(pages)) {
    const full = join(dir, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, html);
  }
  return dir;
}

function run(dir: string) {
  // `node`, not `bun`: the deploy runner has only actions/setup-node. Running it the
  // way CI runs it is the point — a test that used bun would not prove it works there.
  const r = spawnSync("node", [ENTRY, "--site", dir], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("site-inject-ci", () => {
  test("fills a placeholder from the committed payload", () => {
    const dir = site({ "index.html": page(`<pre data-snippet="sql-migration"></pre>`) });
    const r = run(dir);
    expect(r.code).toBe(0);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain("CREATE TABLE");
    expect(html).not.toContain(`data-snippet="sql-migration"></pre>`);
  });

  test("appends the styled expander for a snippet that ships its whole file", () => {
    const dir = site({ "index.html": page(`<pre data-snippet="ts-entity"></pre>`) });
    expect(run(dir).code).toBe(0);
    expect(readFileSync(join(dir, "index.html"), "utf8"))
      .toContain(`<details class="example-details">`);
  });

  // Hard fail. The page would otherwise deploy with a visibly empty code block, and
  // nothing downstream of this step would notice.
  test("FAILS when a page names an id the payload does not build", () => {
    const dir = site({ "index.html": page(`<pre data-snippet="no-such-snippet"></pre>`) });
    const r = run(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no-such-snippet");
  });

  // Warn, NOT fail — the asymmetry is the whole design. Running the bidirectional
  // check here would fail every unrelated site edit, prose included, from the moment
  // a placeholder lands until the next metaobjects release. The bidirectional half
  // lives in the release preflight, where it is fixable before anything publishes.
  test("WARNS but succeeds when a payload entry is on no page", () => {
    const dir = site({ "index.html": page(`<pre data-snippet="sql-migration"></pre>`) });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain("warn");
    expect(r.out).toContain("ts-entity");   // one of the many unreferenced ids
  });

  test("is idempotent — a second deploy does not double the expander", () => {
    const dir = site({ "index.html": page(`<pre data-snippet="ts-entity"></pre>`) });
    run(dir);
    const once = readFileSync(join(dir, "index.html"), "utf8");
    run(dir);
    const twice = readFileSync(join(dir, "index.html"), "utf8");
    expect(twice).toBe(once);
    expect([...twice.matchAll(/<details[^>]*>/g)]).toHaveLength(1);
  });

  test("walks nested directories, so an article page is not skipped", () => {
    const dir = site({
      "index.html": page(`<pre data-snippet="sql-migration"></pre>`),
      "articles/deep.html": page(`<pre data-snippet="showcase-prompt"></pre>`),
    });
    expect(run(dir).code).toBe(0);
    expect(readFileSync(join(dir, "articles/deep.html"), "utf8"))
      .toContain("template.prompt");
  });
});
