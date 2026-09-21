import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { Hono } from "hono";
import { metaJson, META_CONTENT_TYPE } from "../src/meta-endpoint.js";
import { mountMetaRoute } from "../src/fastify/index.js";
import { mountMetaRouteHono } from "../src/hono/index.js";
import { loadTestModel } from "./helpers/load-test-model.js";

describe("GET /_meta (fastify)", () => {
  test("serves the effective canonical JSON under the prefix", async () => {
    const root = await loadTestModel();
    const app = Fastify();
    mountMetaRoute({ fastify: app, root, prefix: "/api" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/_meta" });

    expect(res.statusCode).toBe(200);
    // Pinned independently of META_CONTENT_TYPE: asserting only against the constant
    // the mounts also use proves the two mounts AGREE, but cannot catch the constant
    // itself being wrong. One literal here closes that loop.
    expect(META_CONTENT_TYPE).toBe("application/json; charset=utf-8");
    expect(res.headers["content-type"]).toBe(META_CONTENT_TYPE);
    expect(res.body).toBe(metaJson(root));
  });

  test("mounts at the bare path when no prefix is given", async () => {
    const root = await loadTestModel();
    const app = Fastify();
    mountMetaRoute({ fastify: app, root });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/_meta" })).statusCode).toBe(200);
  });
});

describe("GET /_meta (hono)", () => {
  test("serves the same bytes and headers as the fastify mount", async () => {
    const root = await loadTestModel();
    const app = new Hono();
    mountMetaRouteHono({ app, root, prefix: "/api" });

    const res = await app.request("/api/_meta");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(META_CONTENT_TYPE);
    expect(await res.text()).toBe(metaJson(root));
  });
});
