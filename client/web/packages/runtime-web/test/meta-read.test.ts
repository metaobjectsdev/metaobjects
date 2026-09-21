import { describe, test, expect } from "bun:test";
import { buildGrid } from "../src/grid-from-metadata.js";
import type { MetaRead } from "../src/meta-read.js";

/** A hand-built model satisfying MetaRead — proves buildGrid no longer requires
 *  a real MetaObject, which is what lets a browser model drive it. */
const stub: MetaRead = {
  name: "Author",
  subType: "entity",
  attr: () => undefined,
  fields: () => [
    { name: "firstName", subType: "string", attr: () => undefined, views: () => [] },
    { name: "createdAt", subType: "timestamp", attr: () => undefined, views: () => [] },
  ],
  layouts: () => [],
};

describe("MetaRead", () => {
  test("buildGrid accepts any MetaRead, not only a MetaObject", () => {
    const grid = buildGrid(stub);
    expect(grid.columns.map((c) => c.field)).toEqual(["firstName", "createdAt"]);
  });

  test("headers humanize when no view supplies a title", () => {
    expect(buildGrid(stub).columns[0]!.header).toBe("First Name");
  });
});
