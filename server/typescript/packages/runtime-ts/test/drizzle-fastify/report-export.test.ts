import type { FilterAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";
// Report export on both read-only mounts (Fastify and Hono): the selector, the 400 envelopes, the
// export cap, the headers. The CSV and XML writers are stand-ins; the real ones are generated.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteView } from "drizzle-orm/sqlite-core";
import { mountReadOnlyCrudRoutes as mountFastify } from "../../src/drizzle-fastify/mount-read-only.js";
import { mountReadOnlyCrudRoutes as mountHono } from "../../src/hono/mount-read-only.js";
import {
  EXPORT_FORMATS, exportContentDisposition, parseExportPage, readExportFormat, wiredExportFormats,
  type ReportExportSpec,
} from "../../src/drizzle-fastify/report-export.js";

const csv = (rows: readonly Record<string, unknown>[]): string =>
  `n\r\n${rows.map((r) => String(r["n"])).join("\r\n")}\r\n`;
const xml = (rows: readonly Record<string, unknown>[]): string =>
  `<Days>${rows.map((r) => `<row><n>${String(r["n"])}</n></row>`).join("")}</Days>`;
const SPEC: ReportExportSpec = { maxRows: 5, csv, xml };

describe("report-export helpers", () => {
  test("formats in contract order; json is always wired", () => {
    expect([...EXPORT_FORMATS]).toEqual(["csv", "json", "xml"]);
    expect(wiredExportFormats({ maxRows: 1 })).toEqual(["json"]);
    expect(wiredExportFormats({ maxRows: 1, xml })).toEqual(["json", "xml"]);
    expect(wiredExportFormats(SPEC)).toEqual(["csv", "json", "xml"]);
  });

  test("no format key is no export; a wrong spelling is invalid_format listing the wired formats", () => {
    expect(readExportFormat({}, SPEC)).toBeUndefined();
    expect(readExportFormat({ format: "xml" }, SPEC)).toBe("xml");
    for (const bad of ["CSV", "", "xlsx", ["csv", "json"], { a: "b" }]) {
      try {
        readExportFormat({ format: bad }, SPEC);
        throw new Error("expected a refusal");
      } catch (e) {
        expect((e as { body?: unknown }).body).toEqual({ error: "invalid_format", expected: ["csv", "json", "xml"] });
      }
    }
  });

  test("the page: absent limit fetches maxRows+1, explicit above the cap is export_too_large", () => {
    expect(parseExportPage({}, 5)).toEqual({ limit: 6, offset: 0, unbounded: true });
    expect(parseExportPage({ limit: "5", offset: "2" }, 5)).toEqual({ limit: 5, offset: 2, unbounded: false });
    expect(() => parseExportPage({ limit: "6" }, 5)).toThrow();
    try { parseExportPage({ limit: "6" }, 5); } catch (e) {
      expect((e as { body?: unknown }).body).toEqual({ error: "export_too_large", maxRows: 5 });
    }
  });

  test("the disposition names the last path segment", () => {
    expect(exportContentDisposition("/api/days", "csv")).toBe('attachment; filename="days.csv"');
  });
});

describe("report export on the read-only mounts", () => {
  let client: ReturnType<typeof createClient>;
  const view = () => sqliteView("v_days", { id: integer("id").notNull(), n: integer("n").notNull() }).existing();
  const common = () => ({
    path: "/days", db: drizzle(client), view: view(),
    filterAllowlist: { n: { ops: ["eq", "lte"], subType: "number", leadingWildcard: false } } as FilterAllowlist,
    sortAllowlist: { id: { defaultOrder: "asc" as const } },
    dialect: "sqlite" as const, itemRoutes: false, resource: "report" as const,
  });

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE days (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
    await client.execute(`CREATE VIEW v_days AS SELECT id, n FROM days`);
    await client.execute(`INSERT INTO days (id, n) VALUES ${Array.from({ length: 6 }, (_, i) => `(${i + 1}, ${i + 1})`).join(",")}`);
  });
  afterAll(() => client.close());

  interface Answer { status: number; headers: (name: string) => string | null; text: string }
  const surfaces: Array<[string, (spec: ReportExportSpec | undefined) => Promise<(url: string) => Promise<Answer>>]> = [
    ["fastify", async (spec) => {
      const app = Fastify();
      mountFastify({ fastify: app, ...common(), ...(spec ? { export: spec } : {}) });
      await app.ready();
      return async (url) => {
        const r = await app.inject({ method: "GET", url });
        return { status: r.statusCode, headers: (n) => (r.headers[n] as string | undefined) ?? null, text: r.body };
      };
    }],
    ["hono", async (spec) => {
      const app = new Hono();
      mountHono({ app, ...common(), ...(spec ? { export: spec } : {}) });
      return async (url) => {
        const r = await app.request(url);
        return { status: r.status, headers: (n) => r.headers.get(n), text: await r.text() };
      };
    }],
  ];

  for (const [name, boot] of surfaces) {
    describe(name, () => {
      test("csv, xml and json: body, content type, disposition", async () => {
        const get = await boot(SPEC);
        const c = await get("/days?format=csv&limit=2");
        expect(c.status).toBe(200);
        expect(c.text).toBe("n\r\n1\r\n2\r\n");
        expect(c.headers("content-type")).toBe("text/csv; charset=utf-8");
        expect(c.headers("content-disposition")).toBe('attachment; filename="days.csv"');
        const x = await get("/days?format=xml&limit=1");
        expect(x.text).toBe("<Days><row><n>1</n></row></Days>");
        expect(x.headers("content-type")).toBe("application/xml");
        const j = await get("/days?format=json&limit=1");
        expect(JSON.parse(j.text)).toEqual([{ id: 1, n: 1 }]);
        expect(j.headers("content-type")).toBe("application/json");
        expect(j.headers("content-disposition")).toBe('attachment; filename="days.json"');
      });

      test("six rows against maxRows 5: export_too_large for every format, and for an explicit limit above it", async () => {
        const get = await boot(SPEC);
        for (const url of ["/days?format=csv", "/days?format=json", "/days?format=xml", "/days?format=csv&limit=6"]) {
          const r = await get(url);
          expect(r.status).toBe(400);
          expect(JSON.parse(r.text)).toEqual({ error: "export_too_large", maxRows: 5 });
          expect(r.headers("content-disposition")).toBeNull();
        }
        expect((await get("/days?format=csv&filter[n][lte]=5")).status).toBe(200);
      });

      test("invalid_format, export_with_count and the list route's own filter errors", async () => {
        const get = await boot(SPEC);
        const bad = await get("/days?format=pdf");
        expect(bad.status).toBe(400);
        expect(JSON.parse(bad.text)).toEqual({ error: "invalid_format", expected: ["csv", "json", "xml"] });
        expect(JSON.parse((await get("/days?format=")).text).error).toBe("invalid_format");
        const wc = await get("/days?format=json&withCount=1");
        expect(wc.status).toBe(400);
        expect(JSON.parse(wc.text).error).toBe("export_with_count");
        expect(JSON.parse((await get("/days?format=csv&withCount=true")).text).error).toBe("export_with_count");
        const f = await get("/days?format=csv&filter[nope][eq]=1");
        expect(JSON.parse(f.text).error).toBe("invalid_filter_field");
      });

      test("without format the list route is unchanged: no disposition, report_too_large still answers", async () => {
        const get = await boot({ ...SPEC, maxRows: 100 });
        const list = await get("/days");
        expect(JSON.parse(list.text)).toHaveLength(6);
        expect(list.headers("content-disposition")).toBeNull();
        // ?format set: the export cap governs, so a default-capped list never says report_too_large
        expect((await get("/days?format=csv")).status).toBe(200);
      });

      test("with no export spec wired, ?format= is ignored like any unknown parameter", async () => {
        const get = await boot(undefined);
        const r = await get("/days?format=csv");
        expect(r.status).toBe(200);
        expect(JSON.parse(r.text)).toHaveLength(6);
        expect(r.headers("content-disposition")).toBeNull();
      });
    });
  }
});
