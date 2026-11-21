// The TypeScript runner of `fixtures/list-query-conformance/` — the shared parse cases of the
// REST standard's list handling (plan R0): a query string and the corpus model's field list
// in, a filter tree (with search, sort and page) or the named 400 body out. No web server and
// no database: what is pinned is the parse, which every port's list route runs before its
// query library sees anything.
//
// TypeScript is the SOURCE of the expected answers. The field list is derived from the model
// the way each port's generator derives its allowlist (here `filterAllowlistRules` /
// `sortAllowlistRules`, the data the generated `<Entity>FilterAllowlist` is printed from), so
// a port that derives a different allowlist fails here before any route runs.
//
// Regenerate after an intended change: `UPDATE_LIST_QUERY_FIXTURES=1 bun test
// test/list-query-conformance.test.ts`, then review every changed answer — it is the
// cross-port contract.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMetaObject, type MetaObject } from "@metaobjectsdev/metadata";
import { filterAllowlistRules, sortAllowlistRules } from "@metaobjectsdev/codegen-ts";
import { FilterParseError, parseListQuery, parseListQueryString, type ListQuery } from "@metaobjectsdev/runtime-ts";
import type { FilterAllowlist, SortAllowlist } from "@metaobjectsdev/runtime-ts";
import { contractErrorCode } from "@metaobjectsdev/runtime-ts/drizzle-fastify";
import { LIST_QUERY_CONFORMANCE_DIR } from "../src/paths.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";

const CASES_PATH = join(LIST_QUERY_CONFORMANCE_DIR, "cases.json");
const UPDATE = process.env.UPDATE_LIST_QUERY_FIXTURES === "1";

interface ParseCase {
  group: string;
  name: string;
  query: string;
  why: string;
  /** `{ list }` — the parsed query, absent members omitted; `{ error }` — the 400 body. */
  expect?: { list: ListQuery } | { error: Record<string, unknown> };
}

const corpus = JSON.parse(readFileSync(CASES_PATH, "utf8")) as { cases: ParseCase[] };

async function ticket(): Promise<MetaObject> {
  const root = await loadMetadataFile(join(LIST_QUERY_CONFORMANCE_DIR, "meta.json"));
  const entity = root.children().find((c) => isMetaObject(c) && c.name === "Ticket");
  if (entity === undefined || !isMetaObject(entity)) throw new Error("list-query-conformance: no Ticket in meta.json");
  return entity;
}

/** The answer a list route gives a case: the parsed query, or the 400 body it refuses with. */
function answer(query: string, filter: FilterAllowlist, sort: SortAllowlist, fields: readonly string[]): NonNullable<ParseCase["expect"]> {
  try {
    const list = parseListQuery({
      query: parseListQueryString(query),
      allowlist: filter,
      sortAllowlist: sort,
      isField: (name) => fields.includes(name),
    });
    // Through JSON, so the pinned form is exactly what a port reads back (no undefined members).
    return { list: JSON.parse(JSON.stringify(list)) as ListQuery };
  } catch (err) {
    if (!(err instanceof FilterParseError)) throw err;
    return { error: { error: contractErrorCode(err.code), ...(err.details ?? {}) } };
  }
}

describe("list-query-conformance", async () => {
  const entity = await ticket();
  const filter = Object.fromEntries(filterAllowlistRules(entity)) as unknown as FilterAllowlist;
  const sort = Object.fromEntries(sortAllowlistRules(entity)) as SortAllowlist;
  const fields = entity.fields().map((f) => f.name);

  test("the corpus is not empty and every name is unique", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(new Set(corpus.cases.map((c) => c.name)).size).toBe(corpus.cases.length);
  });

  if (UPDATE) {
    test("regenerate expected answers", () => {
      for (const c of corpus.cases) c.expect = answer(c.query, filter, sort, fields);
      writeFileSync(CASES_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
    });
    return;
  }

  for (const c of corpus.cases) {
    test(`${c.group}/${c.name}`, () => {
      expect(c.expect).toBeDefined();
      expect(answer(c.query, filter, sort, fields)).toEqual(c.expect as NonNullable<ParseCase["expect"]>);
    });
  }
});
