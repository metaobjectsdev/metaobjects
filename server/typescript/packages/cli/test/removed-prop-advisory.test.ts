// F99 — the OTHER half of the 1.0 provider migration, found in a second adopter.
//
// F52's advisory catches the adopter who renames `value` → `fetcher` and forgets `baseUrl`.
// This one catches the adopter who never renamed at all. `<EntityFetcherProvider value={f}>`
// does not typecheck — and the migration note, and F52's own header comment, both rest a
// safety argument on exactly that. The argument holds only where `tsc` is in the gate chain.
//
// It was not, twice. One adopter lost a round to it: a red render smoke test that looked
// like the release candidate breaking, and was an unfinished migration step. A second then
// shipped the identical construct in its web entry point and carried it through a whole
// upgrade pass, because `vite build` transpiles without typechecking and a provider with the
// wrong prop still RENDERS — the children mount, and only a component that actually calls a
// generated hook fails, at runtime, in the browser.
//
// Two adopters, same component, same wrong prop, invisible to every gate either project ran.
// The rename was ours, so the advisory is ours.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForRemovedProps } from "../src/lib/removed-prop-advisory.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-removedprop-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  return root;
}

describe("scanForRemovedProps", () => {
  test("the construct both estates shipped", async () => {
    const root = await project({
      "src/main.tsx":
        `<EntityFetcherProvider value={entityFetcher}>\n  <App />\n</EntityFetcherProvider>`,
    });
    const found = scanForRemovedProps(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe("src/main.tsx");
    expect(found[0]!.line).toBe(1);
    expect(found[0]!.prop).toBe("value");
    expect(found[0]!.message).toContain("fetcher");
  });

  test("silent on the corrected form", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider fetcher={entityFetcher} baseUrl="/api">`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  test("fires regardless of apiPrefix — a wrong prop is wrong at every prefix", async () => {
    // Deliberately unlike the baseUrl advisory, which is silent when apiPrefix is "".
    // There is no configuration under which `value` reaches the provider.
    const root = await project({ "src/main.tsx": `<EntityFetcherProvider value={f}>` });
    expect(scanForRemovedProps(root)).toHaveLength(1);
  });

  test("reports the real line in a multi-line tag", async () => {
    const root = await project({
      "src/main.tsx":
        `import x from "y";\n\nrender(\n  <EntityFetcherProvider\n    value={f}\n  >\n    <App />\n  </EntityFetcherProvider>\n);`,
    });
    const found = scanForRemovedProps(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(4);
  });

  // --- the false positives a looser rule would produce -------------------------

  test("a prop whose NAME merely ends in the removed one is not it", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider fetcher={f} defaultValue={1} initialValue={2}>`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  test("`value` inside a nested expression is not a prop of this tag", async () => {
    // The tokenizer returns the whole opening tag, nested braces included. A substring
    // match would convict all three of these.
    const root = await project({
      "src/main.tsx":
        `<EntityFetcherProvider fetcher={mk({ value: 1 })}>\n` +
        `<EntityFetcherProvider fetcher={o.value === 1 ? a : b}>\n` +
        `<EntityFetcherProvider fetcher={<Inner value={9} />}>`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  test("a string containing the prop text is not code", async () => {
    const root = await project({
      "src/main.tsx": `<EntityFetcherProvider fetcher={f} title="pass value={x} here">`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  test("an unrelated component with a value prop is untouched", async () => {
    const root = await project({
      "src/main.tsx": `<SomeOtherProvider value={f}>\n<QueryClientProvider value={q}>`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  // --- the same exclusions the advisory beside it makes ------------------------

  test("build output is not authored source (F89)", async () => {
    const root = await project({
      "public/main.js": `<EntityFetcherProvider value={f}>` + " ".repeat(5200) + `;`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });

  test("node_modules and tests are skipped", async () => {
    const root = await project({
      "node_modules/p/index.tsx": `<EntityFetcherProvider value={f}>`,
      "src/main.test.tsx": `<EntityFetcherProvider value={f}>`,
      "src/types.d.ts": `<EntityFetcherProvider value={f}>`,
    });
    expect(scanForRemovedProps(root)).toEqual([]);
  });
});
