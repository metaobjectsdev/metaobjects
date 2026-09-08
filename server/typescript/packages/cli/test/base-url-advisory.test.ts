// F52 — the half of the 1.0 base-URL migration that nothing else can see.
//
// `<EntityFetcherProvider value={fetcher}>` no longer typechecks, and the migration note
// rests its safety argument on that. But `baseUrl` is OPTIONAL, defaulting to "", so an
// adopter who reads the note, renames `value` → `fetcher` and stops has a tree that
// compiles clean while every generated hook has quietly lost its `/api` segment. On the
// estate where this was found, `vite build`, 150 tests and every `meta verify` gate were
// green over two apps whose entire generated CRUD surface would have 404'd; `tsc --noEmit`
// run by hand was the only signal in the building, and it cannot see this half at all.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForMissingBaseUrl } from "../src/lib/base-url-advisory.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-baseurl-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  return root;
}

describe("scanForMissingBaseUrl", () => {
  test("the half that compiles — renamed to fetcher, no baseUrl", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider fetcher={fetcher}>\n  <App />\n</EntityFetcherProvider>`,
    });
    const found = scanForMissingBaseUrl(root, "/api");
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe("src/main.tsx");
    expect(found[0]!.message).toContain("/api");
  });

  test("silent when the provider passes a base", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">`,
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });

  test("silent when apiPrefix is empty — what `meta init` scaffolds", async () => {
    // The trap ships easily precisely because the DEFAULT-configured project is the one
    // the design was reasoned about. Firing here would nag every scaffolded project.
    const root = await project({ "src/main.tsx": `<EntityFetcherProvider fetcher={fetcher}>` });
    expect(scanForMissingBaseUrl(root, "")).toEqual([]);
  });

  test("multi-line JSX with a `>` inside an attribute is still matched", async () => {
    // A per-line rule (which is what the anti-pattern scan uses) sees neither the
    // provider and its props together nor past an arrow function. Real code is written
    // this way, so a scan that only handled one line would report clean on the estate.
    const root = await project({
      "src/main.tsx": [
        `<EntityFetcherProvider`,
        `  fetcher={fetcher}`,
        `  onError={(e) => report(e)}`,
        `>`,
      ].join("\n"),
    });
    expect(scanForMissingBaseUrl(root, "/api")).toHaveLength(1);
  });

  test("multi-line JSX that DOES pass a base after an arrow attribute is silent", async () => {
    // The other half of the same mechanism: cutting the tag at the first `>` would end it
    // inside `onError` and report a false positive on a correct file.
    const root = await project({
      "src/main.tsx": [
        `<EntityFetcherProvider`,
        `  fetcher={fetcher}`,
        `  onError={(e) => report(e)}`,
        `  baseUrl={import.meta.env.VITE_API_BASE}`,
        `>`,
      ].join("\n"),
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });

  test("the Angular provider is covered too", async () => {
    const bare = await project({ "src/app.config.ts": `provideEntityFetcher({ fetcher })` });
    expect(scanForMissingBaseUrl(bare, "/api")).toHaveLength(1);
    const full = await project({
      "src/app.config.ts": `provideEntityFetcher({ fetcher, baseUrl: "/api" })`,
    });
    expect(scanForMissingBaseUrl(full, "/api")).toEqual([]);
  });

  test("build output and dependencies are not scanned", async () => {
    const root = await project({
      "node_modules/pkg/index.js": `<EntityFetcherProvider fetcher={f}>`,
      "dist/main.js": `<EntityFetcherProvider fetcher={f}>`,
      "src/x.test.tsx": `<EntityFetcherProvider fetcher={f}>`,
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });
});

// The three cases a bracket count got wrong. Each was reproduced against the module
// before the tokenizer replaced the count, and each is a way an advisory can be worse
// than absent: two nag a correct provider, one suppresses a real finding.
describe("scanForMissingBaseUrl — what is code and what is not", () => {
  test("a `>` inside a STRING attribute does not end the tag", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider title="a > b" fetcher={fetcher} baseUrl="/api">`,
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });

  test("a `//` comment between attributes does not end the tag", async () => {
    const root = await project({
      "src/main.tsx": [
        `<EntityFetcherProvider`,
        `  // an arrow => lives here, and a > with it`,
        `  fetcher={fetcher}`,
        `  baseUrl="/api"`,
        `>`,
      ].join("\n"),
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });

  test("a block comment between attributes does not end the tag", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider /* > */ fetcher={f} baseUrl="/api">`,
    });
    expect(scanForMissingBaseUrl(root, "/api")).toEqual([]);
  });

  test("an unbalanced `)` inside a string does not SUPPRESS a real finding", async () => {
    // The dangerous direction. Counting brackets, the `)` in the string left depth
    // permanently above zero, so the scan ran to its 4000-char cap and found the
    // unrelated `baseUrl` below — reporting clean over a provider that has none.
    const root = await project({
      "src/main.tsx": [
        `<EntityFetcherProvider fetcher={mk(")")}>`,
        `  <App />`,
        `</EntityFetcherProvider>`,
        ``,
        `const elsewhere = { baseUrl: "/api" };`,
      ].join("\n"),
    });
    expect(scanForMissingBaseUrl(root, "/api")).toHaveLength(1);
  });

  test("a symlinked directory is not followed", async () => {
    // Following them had no visited set: `src/loop -> <root>` produced 41 findings for
    // ONE file and stopped only at Linux's ELOOP limit. A provider reachable through a
    // link is reachable through its real path, so the duplicates were pure inflation of
    // the count `verify` prints — and a link out of the project walked foreign trees.
    const root = await project({ "src/main.tsx": `<EntityFetcherProvider fetcher={f}>` });
    await symlink(root, join(root, "src", "loop"), "dir");
    expect(scanForMissingBaseUrl(root, "/api")).toHaveLength(1);
  });
});
