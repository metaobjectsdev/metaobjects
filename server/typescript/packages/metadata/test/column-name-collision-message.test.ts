import { expect, test } from "bun:test";
import { join } from "node:path";
import { tsAdapter } from "./conformance/adapter.js";

const CORPUS = join(import.meta.dir, "../../../../../fixtures/conformance");
const PROVIDERS = ["metaobjects-core-types", "metaobjects-db"];

async function messages(fixture: string): Promise<string[]> {
  const out = await tsAdapter.loadFixture(join(CORPUS, fixture, "input"), PROVIDERS);
  return (out.errors ?? []).map((e) => e.message ?? "");
}

test("two explicit @column on one column: advice does not suggest adding @column", async () => {
  const [msg] = await messages("error-column-name-collision-derived-view");
  expect(msg).toContain("point one @column at a different column");
  expect(msg).not.toContain("give one an explicit @column");
});

test("implicit collision still suggests an explicit @column", async () => {
  const [msg] = await messages("error-column-name-collision");
  expect(msg).toContain("give one an explicit @column");
});

test("an @sql view may share a column between fields", async () => {
  expect(await messages("column-name-shared-in-sql-view-ok")).toEqual([]);
});
