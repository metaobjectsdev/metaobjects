// The check every generated API lane runs (FR-022), held to failing. A lane that passes proves
// nothing unless the check can refuse, so each way a server and its document can disagree is here,
// with no server: one exchange at a time against a corpus document. No Docker needed.

import { describe, expect, test } from "bun:test";
import { openApiCheck } from "../src/api-contract-openapi-check.ts";
import type { ApiRequest, HttpMethod } from "../src/api-contract-scenario.ts";

const check = openApiCheck("blog");

function request(method: HttpMethod, path: string, body?: unknown): ApiRequest {
  return { id: "probe", method, path, body, expect: { status: 200 } };
}

const AUTHOR = { id: 1, name: "Ada", bio: null, createdAt: "2026-10-30T09:30:00Z", issuedCurrency: null, autoCreatedAt: null, autoUpdatedAt: null };

describe("openApiCheck", () => {
  test("takes an exchange the document states", () => {
    const row = { ...AUTHOR };
    expect(() => check(request("GET", "/api/authors?limit=10&offset=0&withCount=1"), 200, JSON.stringify({ rows: [row], total: 1 }))).not.toThrow();
    expect(() => check(request("GET", "/api/authors"), 200, JSON.stringify([row]))).not.toThrow();
    expect(() => check(request("GET", "/api/authors/1"), 200, JSON.stringify(row))).not.toThrow();
    expect(() => check(request("GET", "/api/authors/999"), 404, JSON.stringify({ error: "not_found" }))).not.toThrow();
  });

  test("takes a 404 or 405 on a route the document does not hold", () => {
    expect(() => check(request("GET", "/api/nothing"), 404, "")).not.toThrow();
    expect(() => check(request("DELETE", "/api/nothing/1"), 405, "")).not.toThrow();
  });

  test("refuses a route the document does not hold, when it answers", () => {
    expect(() => check(request("GET", "/api/nothing"), 200, "[]")).toThrow("does not hold");
  });

  test("refuses a status the document does not list", () => {
    expect(() => check(request("GET", "/api/authors/1"), 418, "{}")).toThrow("does not list");
  });

  test("refuses a response that does not match its schema", () => {
    expect(() => check(request("GET", "/api/authors/1"), 200, JSON.stringify({ id: "one" }))).toThrow("does not match");
  });

  test("refuses a list that is neither the array nor the page", () => {
    expect(() => check(request("GET", "/api/authors"), 200, JSON.stringify({ rows: [AUTHOR] }))).toThrow("does not match");
  });

  test("refuses an error that is not the envelope", () => {
    expect(() => check(request("GET", "/api/authors/1"), 404, JSON.stringify({ message: "no" }))).toThrow("does not match");
  });

  test("refuses a query parameter a 2xx answered and the document does not state", () => {
    expect(() => check(request("GET", "/api/authors?shiny=1"), 200, "[]")).toThrow("'shiny' is not in the document");
  });

  test("leaves the TypeScript-only extensions alone", () => {
    expect(() => check(request("GET", "/api/authors?search=ada"), 200, "[]")).not.toThrow();
  });

  test("refuses a request body the document would not accept, when a 2xx took it", () => {
    expect(() => check(request("POST", "/api/authors", { name: 7 }), 201, JSON.stringify(AUTHOR))).toThrow("the request body");
  });

  test("leaves a request the server refused alone: those scenarios send bad input on purpose", () => {
    expect(() => check(request("POST", "/api/authors", { name: 7 }), 400, JSON.stringify({ error: "validation" }))).not.toThrow();
  });
});
