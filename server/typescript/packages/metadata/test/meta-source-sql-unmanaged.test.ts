// #208 Task 2 — MetaSource resolving accessors for @sql / @unmanaged
// (registered in Task 1, commit 5ecacb01). Mirrors the effectiveKind/role
// accessor test pattern in test/source-rdb.test.ts.

import { expect, test } from "bun:test";
import { loadString } from "../src/index.js";
import { MetaSource } from "../src/persistence/source/meta-source.js";

test("MetaSource exposes @sql body and @unmanaged flag (resolving)", async () => {
  const { root } = await loadString(
    `{"metadata.root":{"package":"t","children":[
      {"object.projection":{"name":"R","children":[
        {"source.rdb":{"@kind":"view","@view":"v_r","@sql":"SELECT 1"}},
        {"field.int":{"name":"x"}}]}}]}}`,
    "json",
  );
  const src = root
    .findObject("R")!
    .ownChildren()
    .find((c) => c instanceof MetaSource)! as MetaSource;
  expect(src.sqlBody).toBe("SELECT 1");
  expect(src.isUnmanaged).toBe(false);
});
