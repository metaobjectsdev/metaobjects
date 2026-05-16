import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_SOURCE,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         SOURCE_SUBTYPE_DB_TABLE, SOURCE_DB_TABLE_ATTR_NAME } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import {
  compileFilter, buildSelectSpec, buildInsertSpec, buildUpdateSpec,
  buildDeleteSpec, buildCountSpec, resolveTableName, resolvePkFields,
} from "../src/query-builder.js";
import { MetadataError } from "../src/errors.js";

function makePost(): MetaModel {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
  post.addChild(title);
  const isPublished = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN), "isPublished");
  post.addChild(isPublished);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  post.addChild(primary);
  return post;
}

describe("resolveTableName", () => {
  test("uses source[dbTable]@name when present", () => {
    const e = makePost();
    const source = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_DB_TABLE), "");
    source.setAttr(SOURCE_DB_TABLE_ATTR_NAME, "blog_posts");
    e.addChild(source);
    expect(resolveTableName(e)).toBe("blog_posts");
  });

  test("falls back to snake_case + plural", () => {
    expect(resolveTableName(makePost())).toBe("posts");
  });
});

describe("resolvePkFields", () => {
  test("returns pk field names from primary identity", () => {
    expect(resolvePkFields(makePost())).toEqual(["id"]);
  });

  test("throws MetadataError when no primary identity", () => {
    const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "X");
    expect(() => resolvePkFields(e)).toThrow(MetadataError);
  });
});

describe("compileFilter — equality", () => {
  test("{ id: 42 } → eq", () => {
    expect(compileFilter(makePost(), { id: 42 })).toEqual({
      kind: "eq", column: "id", value: 42,
    });
  });

  test("multiple keys → and(eq, eq)", () => {
    const c = compileFilter(makePost(), { id: 42, title: "x" });
    expect(c.kind).toBe("and");
    if (c.kind === "and") expect(c.clauses).toHaveLength(2);
  });

  test("{ field: null } → isNull", () => {
    expect(compileFilter(makePost(), { title: null })).toEqual({
      kind: "isNull", column: "title", not: false,
    });
  });

  test("{ field: [a, b] } → in(...)", () => {
    expect(compileFilter(makePost(), { id: [1, 2, 3] })).toEqual({
      kind: "in", column: "id", values: [1, 2, 3],
    });
  });
});

describe("compileFilter — operators", () => {
  test("$gt, $gte, $lt, $lte", () => {
    expect(compileFilter(makePost(), { id: { $gt: 5 } })).toEqual({
      kind: "gt", column: "id", value: 5,
    });
    expect(compileFilter(makePost(), { id: { $lte: 100 } })).toEqual({
      kind: "lte", column: "id", value: 100,
    });
  });

  test("$like", () => {
    expect(compileFilter(makePost(), { title: { $like: "%foo%" } })).toEqual({
      kind: "like", column: "title", pattern: "%foo%",
    });
  });

  test("$ne", () => {
    expect(compileFilter(makePost(), { id: { $ne: 1 } })).toEqual({
      kind: "ne", column: "id", value: 1,
    });
  });

  test("$isNull: true → isNull", () => {
    expect(compileFilter(makePost(), { title: { $isNull: true } })).toEqual({
      kind: "isNull", column: "title", not: false,
    });
  });

  test("$isNull: false → IS NOT NULL", () => {
    expect(compileFilter(makePost(), { title: { $isNull: false } })).toEqual({
      kind: "isNull", column: "title", not: true,
    });
  });

  test("$in operator (explicit)", () => {
    expect(compileFilter(makePost(), { id: { $in: [1, 2] } })).toEqual({
      kind: "in", column: "id", values: [1, 2],
    });
  });
});

describe("compileFilter — $and", () => {
  test("explicit $and → and(...)", () => {
    const c = compileFilter(makePost(), { $and: [{ id: 1 }, { title: "x" }] });
    expect(c.kind).toBe("and");
    if (c.kind === "and") expect(c.clauses).toHaveLength(2);
  });

  test("nested $and → flattened (single and-clause)", () => {
    const c = compileFilter(makePost(), { $and: [{ $and: [{ id: 1 }] }, { title: "x" }] });
    expect(c.kind).toBe("and");
  });
});

describe("compileFilter — column name resolution", () => {
  test("uses @dbColumn attr when present", () => {
    const e = makePost();
    const title = e.children().find((c) => c.name === "title")!;
    title.setAttr("dbColumn", "post_title");
    expect(compileFilter(e, { title: "x" })).toEqual({
      kind: "eq", column: "post_title", value: "x",
    });
  });

  test("falls back to snake_case", () => {
    const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "X");
    e.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "firstName"));
    expect(compileFilter(e, { firstName: "x" })).toEqual({
      kind: "eq", column: "first_name", value: "x",
    });
  });
});

describe("compileFilter — unknown fields throw", () => {
  test("MetadataError for unknown field name", () => {
    expect(() => compileFilter(makePost(), { nonExistent: 1 })).toThrow(MetadataError);
  });
});

describe("buildSelectSpec", () => {
  test("default: all field columns + PK", () => {
    const spec = buildSelectSpec(makePost(), undefined, {});
    expect(spec.table).toBe("posts");
    expect(spec.columns).toContain("id");
    expect(spec.columns).toContain("title");
    expect(spec.where).toBeUndefined();
  });

  test("with limit + offset + orderBy", () => {
    const spec = buildSelectSpec(makePost(), undefined, {
      limit: 10, offset: 5, orderBy: ["title", "asc"],
    });
    expect(spec.limit).toBe(10);
    expect(spec.offset).toBe(5);
    expect(spec.orderBy).toEqual([{ column: "title", direction: "asc" }]);
  });

  test("orderBy multi-column", () => {
    const spec = buildSelectSpec(makePost(), undefined, {
      orderBy: [["title", "asc"], ["id", "desc"]],
    });
    expect(spec.orderBy).toHaveLength(2);
  });

  test("with view: project to view fields + PK", () => {
    // view fields would come from view.ts; we pass them in as `columns` override (caller does projection)
    const spec = buildSelectSpec(makePost(), undefined, {}, ["title"]);
    expect(spec.columns).toContain("title");
    expect(spec.columns).toContain("id"); // PK always included
  });
});

describe("buildInsertSpec", () => {
  test("table + values + returning columns (PK + all fields)", () => {
    const spec = buildInsertSpec(makePost(), { title: "x", isPublished: true });
    expect(spec.table).toBe("posts");
    expect(spec.values).toEqual({ title: "x", is_published: true });
    expect(spec.returning).toContain("id");
    expect(spec.returning).toContain("title");
  });
});

describe("buildUpdateSpec", () => {
  test("update by PK", () => {
    const spec = buildUpdateSpec(makePost(), { title: "new" }, 42);
    expect(spec.where).toEqual({ kind: "eq", column: "id", value: 42 });
    expect(spec.values).toEqual({ title: "new" });
  });
});

describe("buildDeleteSpec", () => {
  test("delete by PK", () => {
    const spec = buildDeleteSpec(makePost(), 42);
    expect(spec.where).toEqual({ kind: "eq", column: "id", value: 42 });
  });
});

describe("buildCountSpec", () => {
  test("with filter", () => {
    const spec = buildCountSpec(makePost(), { isPublished: true });
    expect(spec.table).toBe("posts");
    expect(spec.where?.kind).toBe("eq");
  });

  test("without filter", () => {
    const spec = buildCountSpec(makePost(), undefined);
    expect(spec.where).toBeUndefined();
  });
});
