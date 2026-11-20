/**
 * `api.pagination` from `.metaobjects/config.json` is honoured: the default page size
 * applies when the caller gives no limit, and a limit above the maximum is refused (never
 * quietly lowered). The setting is read from the loaded model on each request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiPaginationOf } from "@metaobjectsdev/metadata";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

const rowsOf = (body: unknown): unknown[] => body as unknown[];

describe("the project's setting (defaultLimit 10, maxLimit 50)", () => {
  let demo: Demo;
  beforeAll(async () => {
    demo = await openDemo();
  });
  afterAll(async () => {
    await demo.close();
  });

  test("the setting reaches the loaded model", () => {
    expect(apiPaginationOf(demo.runtime.current().root)).toEqual({ defaultLimit: 10, maxLimit: 50 });
  });

  test("no limit means the default page size, not every row", async () => {
    // Twelve work orders are seeded.
    expect(rowsOf((await demo.get("/api/work_orders")).body)).toHaveLength(10);
  });

  test("withCount reports the unpaginated total beside the page", async () => {
    const res = await demo.get("/api/work_orders?withCount=1");
    expect(res.body).toMatchObject({ total: 12 });
    expect((res.body as { rows: unknown[] }).rows).toHaveLength(10);
    // The total follows the filter, not the page.
    expect((await demo.get("/api/work_orders?withCount=1&limit=1&filter[status]=done")).body).toMatchObject({ total: 3 });
  });

  test("a limit up to the maximum is used as given", async () => {
    expect(rowsOf((await demo.get("/api/work_orders?limit=50")).body)).toHaveLength(12);
    expect(rowsOf((await demo.get("/api/work_orders?limit=4")).body)).toHaveLength(4);
    expect(rowsOf((await demo.get("/api/work_orders?limit=0")).body)).toHaveLength(0);
  });

  test("a limit above the maximum is a 400, and no rows are returned", async () => {
    const res = await demo.get("/api/work_orders?limit=51");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "limit_too_large", maxLimit: 50 });
  });

  test("pages do not overlap: rows that tie on the sort field are ordered by their key", async () => {
    // Twelve work orders share four statuses, so most of every page is a tie.
    const pages: { id: number; status: string }[] = [];
    for (const offset of [0, 5, 10]) {
      pages.push(...(rowsOf((await demo.get(`/api/work_orders?sort=status:desc&limit=5&offset=${offset}`)).body) as { id: number; status: string }[]));
    }
    expect(pages.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const expected = [...pages].sort((a, b) => (a.status === b.status ? a.id - b.id : a.status < b.status ? 1 : -1));
    expect(pages).toEqual(expected);
  });

  test("with no sort, pages follow the key", async () => {
    const second = rowsOf((await demo.get("/api/work_orders?limit=5&offset=5")).body) as { id: number }[];
    expect(second.map((row) => row.id)).toEqual([6, 7, 8, 9, 10]);
  });

  test("offset pages through the rows", async () => {
    const ids = async (query: string): Promise<unknown[]> =>
      rowsOf((await demo.get(`/api/work_orders?sort=dueOn&${query}`)).body).map((row) => (row as Record<string, unknown>)["id"]);
    const firstPage = await ids("limit=5");
    const secondPage = await ids("limit=5&offset=5");
    const lastPage = await ids("limit=5&offset=10");
    expect(firstPage).toHaveLength(5);
    expect(secondPage).toHaveLength(5);
    expect(lastPage).toHaveLength(2);
    expect(new Set([...firstPage, ...secondPage, ...lastPage]).size).toBe(12);
  });
});

describe("a different setting in the project config", () => {
  let project: ProjectCopy;
  let demo: Demo;
  beforeAll(async () => {
    project = copyProject();
    project.editConfig((config) => {
      config["api"] = { pagination: { defaultLimit: 3, maxLimit: 5 } };
    });
    demo = await openDemo({ projectDir: project.dir });
  });
  afterAll(async () => {
    await demo.close();
    project.remove();
  });

  test("changes the default and the ceiling with no code change", async () => {
    expect(rowsOf((await demo.get("/api/work_orders")).body)).toHaveLength(3);
    expect(rowsOf((await demo.get("/api/work_orders?limit=5")).body)).toHaveLength(5);
    expect((await demo.get("/api/work_orders?limit=6")).body).toEqual({ error: "limit_too_large", maxLimit: 5 });
  });
});

describe("no api.pagination in the project config", () => {
  let project: ProjectCopy;
  let demo: Demo;
  beforeAll(async () => {
    project = copyProject();
    project.editConfig((config) => {
      delete config["api"];
    });
    demo = await openDemo({ projectDir: project.dir });
  });
  afterAll(async () => {
    await demo.close();
    project.remove();
  });

  test("lists are unbounded, as the generated routes are without the setting", async () => {
    expect(rowsOf((await demo.get("/api/work_orders")).body)).toHaveLength(12);
    expect(rowsOf((await demo.get("/api/work_orders?limit=1000")).body)).toHaveLength(12);
  });

  test("an offset with no limit skips rows and returns the rest", async () => {
    const res = await demo.get("/api/work_orders?offset=5");
    expect(res.status).toBe(200);
    expect((rowsOf(res.body) as { id: number }[]).map((row) => row.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });
});
