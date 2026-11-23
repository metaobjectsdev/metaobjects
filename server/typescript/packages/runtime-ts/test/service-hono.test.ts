// The generated Hono service transport's helpers (`@metaobjectsdev/runtime-ts/service/hono`),
// driven through a real Hono app. The oracle is the api-contract corpus README: a body that does
// not parse answers `400 {"error": "invalid_json"}`, a refusal answers with the status and body the
// service gave it, and a delete answers 204 with no body.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { readBody, sendOpResult } from "../src/service/hono.js";

function echoApp(): Hono {
  const app = new Hono();
  app.post("/echo", async (c) => {
    const read = await readBody(c);
    if (!read.ok) return read.response;
    return c.json({ body: read.body === undefined ? "<none>" : read.body });
  });
  return app;
}

describe("service/hono — readBody", () => {
  test("a JSON body is parsed", async () => {
    const res = await echoApp().request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { a: 1 } });
  });

  test("no body and no JSON content type reads as no input", async () => {
    const res = await echoApp().request("/echo", { method: "POST" });
    expect(await res.json()).toEqual({ body: "<none>" });
  });

  test("a body that does not parse answers 400 invalid_json", async () => {
    const res = await echoApp().request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  test("an empty body sent as JSON answers 400 invalid_json", async () => {
    const res = await echoApp().request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });
});

describe("service/hono — sendOpResult", () => {
  const app = new Hono();
  app.get("/ok", (c) => sendOpResult(c, { ok: true, value: { n: 1 } }, 201, (v) => ({ wire: v.n })));
  app.get("/refused", (c) => sendOpResult(c, { ok: false, status: 409, error: { error: "state_conflict" } }));
  app.get("/gone", (c) => sendOpResult(c, { ok: true, value: undefined }, 204));

  test("a success is sent with its status, mapped to the wire", async () => {
    const res = await app.request("/ok");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ wire: 1 });
  });

  test("a refusal is sent with the service's status and body", async () => {
    const res = await app.request("/refused");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "state_conflict" });
  });

  test("204 sends no body", async () => {
    const res = await app.request("/gone");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
