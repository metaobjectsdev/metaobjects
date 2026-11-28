import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { Hono } from "hono";
import { MetaDataLoader, type MetaData } from "@metaobjectsdev/metadata";
import { META_CONTENT_TYPE, META_DOCS_ROUTE_PATH, metaDocsEtag, metaDocsJson, etagMatches } from "../src/meta-endpoint.js";
import { mountMetaDocsRoute } from "../src/fastify/index.js";
import { mountMetaDocsRouteHono } from "../src/hono/index.js";

// The cross-port oracle: the explorer corpus case with no optional input, whose expected.json is
// the docs view of its model alone (fixtures/explorer-conformance/README.md).
const CASE = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "explorer-conformance", "model-alone");
const EXPECTED = readFileSync(join(CASE, "expected.json"), "utf8");

async function loadCaseModel(): Promise<MetaData> {
  const result = await MetaDataLoader.fromDirectory(join(CASE, "project", "metaobjects"), { strict: true });
  if (result.errors.length > 0) throw new Error(`fixture failed to load: ${result.errors.map(String).join("; ")}`);
  return result.root;
}

describe("the docs view endpoint contract", () => {
  test("sits beside /_meta", () => {
    // Pinned as a literal: the explorer app reads this path from every backend.
    expect(META_DOCS_ROUTE_PATH).toBe("/_meta/docs");
  });

  test("the body is the corpus's docs view of the model alone", async () => {
    expect(metaDocsJson(await loadCaseModel())).toBe(EXPECTED);
  });

  test("routes reach the view", async () => {
    const root = await loadCaseModel();
    const routes = [{ node: "acme::library::Book", method: "get", path: "/api/books" }];
    const body = JSON.parse(metaDocsJson(root, { routes })) as { counts: { routes: number }; nodes: { id: string; routes: unknown[] }[] };
    expect(body.counts.routes).toBe(1);
    expect(body.nodes.find((n) => n.id === "acme::library::Book")!.routes).toEqual([{ method: "GET", path: "/api/books" }]);
    expect(body.nodes.find((n) => n.id === "acme::library::Author")!.routes).toEqual([]);
  });

  test("the ETag follows the body", () => {
    expect(metaDocsEtag("a")).toBe(metaDocsEtag("a"));
    expect(metaDocsEtag("a")).not.toBe(metaDocsEtag("b"));
    expect(metaDocsEtag("ab")).not.toBe(metaDocsEtag("ba"));
    expect(etagMatches(`W/${metaDocsEtag("a")}, "x"`, metaDocsEtag("a"))).toBe(true);
    expect(etagMatches("*", metaDocsEtag("a"))).toBe(true);
    expect(etagMatches(undefined, metaDocsEtag("a"))).toBe(false);
    expect(etagMatches(metaDocsEtag("b"), metaDocsEtag("a"))).toBe(false);
  });
});

describe("GET /_meta/docs (fastify)", () => {
  test("serves the docs view under the prefix, same-origin by default", async () => {
    const root = await loadCaseModel();
    const app = Fastify();
    mountMetaDocsRoute({ fastify: app, root, prefix: "/api" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/_meta/docs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(META_CONTENT_TYPE);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["etag"]).toBe(metaDocsEtag(res.body));
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.body).toBe(EXPECTED);
  });

  test("answers a matching If-None-Match with 304 and no body", async () => {
    const root = await loadCaseModel();
    const app = Fastify();
    mountMetaDocsRoute({ fastify: app, root });
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/_meta/docs" });
    const again = await app.inject({ method: "GET", url: "/_meta/docs", headers: { "if-none-match": String(first.headers["etag"]) } });

    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers["etag"]).toBe(first.headers["etag"]);
  });

  test("allowOrigin opens the route to another origin and exposes the ETag", async () => {
    const root = await loadCaseModel();
    const app = Fastify();
    mountMetaDocsRoute({ fastify: app, root, allowOrigin: "*" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_meta/docs" });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-expose-headers"]).toBe("ETag");
    expect(res.headers["vary"]).toBeUndefined();
  });
});

describe("GET /_meta/docs (hono)", () => {
  test("serves the same bytes and headers as the fastify mount", async () => {
    const root = await loadCaseModel();
    const app = new Hono();
    mountMetaDocsRouteHono({ app, root, prefix: "/api", allowOrigin: "null" });

    const res = await app.request("/api/_meta/docs");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(META_CONTENT_TYPE);
    expect(res.headers.get("etag")).toBe(metaDocsEtag(body));
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(body).toBe(EXPECTED);

    const again = await app.request("/api/_meta/docs", { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });
});
