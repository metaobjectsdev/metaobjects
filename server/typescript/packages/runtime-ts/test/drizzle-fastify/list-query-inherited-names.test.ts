// A name every object inherits (`constructor`, `toString`, `__proto__`) is not a field. The
// allowlists are plain objects, so a truthiness lookup answered "allowed" for them and the
// mounts then ordered or filtered by a column that does not exist. The shared contract says
// an unknown sort field is `400 invalid_sort` and an unknown filter field is
// `400 invalid_filter_field`, whatever the name.

import { describe, test, expect } from "bun:test";
import { parseListQuery, parseListQueryString } from "../../src/drizzle-fastify/list-query.js";
import { FilterParseError } from "../../src/drizzle-fastify/filter-parser.js";
import { sortOrderSpec, type FilterAllowlist, type SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";
import { contractErrorCode } from "../../src/drizzle-fastify/util.js";

const allowlist = { title: { type: "string", ops: ["eq"] } } as unknown as FilterAllowlist;
const sortAllowlist: SortAllowlist = { title: { defaultOrder: "desc" } };

function failure(fn: () => unknown): FilterParseError {
  try {
    fn();
  } catch (err) {
    if (err instanceof FilterParseError) return err;
    throw err;
  }
  throw new Error("expected a FilterParseError");
}

describe("inherited Object property names are not allowlisted fields", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    test(`?sort=${name} is invalid_sort`, () => {
      const err = failure(() => parseListQuery({ query: { sort: name }, allowlist, sortAllowlist }));
      expect(contractErrorCode(err.code)).toBe("invalid_sort");
      expect(err.details?.field).toBe(name);
    });

    test(`filter[${name}] on a hand-built query is an unknown filter field`, () => {
      const filter = JSON.parse(`{ "${name}": { "eq": "x" } }`) as Record<string, unknown>;
      const err = failure(() => parseListQuery({ query: { filter }, allowlist, sortAllowlist }));
      expect(contractErrorCode(err.code)).toBe("invalid_filter_field");
    });

    test(`a ${name} order lookup falls back to asc`, () => {
      expect(sortOrderSpec(sortAllowlist, name, undefined)).toBe("asc");
    });
  }

  test("a declared field still parses, with its declared default order", () => {
    const q = parseListQuery({ query: parseListQueryString("sort=title"), allowlist, sortAllowlist });
    expect(q.sort).toEqual({ field: "title", order: "desc" });
  });
});
