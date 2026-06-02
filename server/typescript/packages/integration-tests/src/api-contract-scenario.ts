// api-contract-scenario.ts — load + execute scenarios from
// fixtures/api-contract-conformance/scenarios/.
//
// Each scenario yaml is `{ name, description, setup?, requests: [...] }`.
// A request is `{ id, method, path, body?, expect: { status, body: ... } }`.
// The body assertion vocabulary is documented in the corpus README; this file
// implements the runner-side mapping of those assertion keys onto bun:test
// expectations.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ExpectBody {
  // One of (or several of) these may be set; the runner enforces only those present.
  equals?: unknown;
  length?: number;
  ids?: number[];
  names?: string[];
  /** Like `names`, but order-insensitive — both sides sorted before compare.
   *  Used by M:N traversal scenarios where the related-row order through a
   *  junction is not contractually fixed (FR-018). */
  namesUnordered?: string[];
  row?: Record<string, unknown>;
  hasId?: boolean;
  envelope?: boolean;
  rowsLength?: number;
  total?: number;
  error?: string;
  empty?: boolean;
}

export interface ExpectBlock {
  status: number;
  body?: ExpectBody;
}

export interface ApiRequest {
  id: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
  expect: ExpectBlock;
}

export interface ApiScenario {
  name: string;
  description?: string;
  setup?: { truncate?: boolean };
  requests: ApiRequest[];
  sourcePath: string;
}

export function loadScenarios(scenarioDir: string): ApiScenario[] {
  const files = readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml")).sort();
  return files.map((f) => parseScenario(join(scenarioDir, f)));
}

function parseScenario(file: string): ApiScenario {
  const raw = yamlLoad(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error(`${file}: top-level YAML must be a mapping`);
  const requests = (raw["requests"] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    name: String(raw["name"] ?? file),
    description: raw["description"] as string | undefined,
    setup: raw["setup"] as { truncate?: boolean } | undefined,
    requests: requests.map((r) => ({
      id: String(r["id"]),
      method: String(r["method"]).toUpperCase() as HttpMethod,
      path: String(r["path"]),
      body: r["body"],
      expect: r["expect"] as ExpectBlock,
    })),
    sourcePath: file,
  };
}

// ---------------------------------------------------------------------------
// Assertion engine
// ---------------------------------------------------------------------------

export function assertResponse(
  scenarioName: string,
  request: ApiRequest,
  status: number,
  body: unknown,
): void {
  if (status !== request.expect.status) {
    throw new Error(
      `${scenarioName} / ${request.id}: expected status ${request.expect.status}, got ${status}; body: ${stringify(body)}`,
    );
  }
  const want = request.expect.body;
  if (!want) return;

  if (want.empty) {
    if (body !== null && body !== undefined && body !== "" && !(typeof body === "object" && Object.keys(body as object).length === 0))
      throw new Error(`${scenarioName} / ${request.id}: expected empty body, got: ${stringify(body)}`);
    return;
  }
  if (want.equals !== undefined) {
    if (stringify(body) !== stringify(want.equals))
      throw new Error(`${scenarioName} / ${request.id}: body mismatch\n  expected: ${stringify(want.equals)}\n  actual:   ${stringify(body)}`);
    return;
  }
  if (want.envelope) {
    const env = body as { rows?: unknown[]; total?: number };
    if (!env || !Array.isArray(env.rows) || typeof env.total !== "number") {
      throw new Error(`${scenarioName} / ${request.id}: expected { rows, total } envelope, got: ${stringify(body)}`);
    }
    if (want.rowsLength !== undefined && env.rows.length !== want.rowsLength) {
      throw new Error(`${scenarioName} / ${request.id}: expected rows.length=${want.rowsLength}, got ${env.rows.length}`);
    }
    if (want.total !== undefined && env.total !== want.total) {
      throw new Error(`${scenarioName} / ${request.id}: expected total=${want.total}, got ${env.total}`);
    }
    return;
  }
  if (want.error !== undefined) {
    const e = (body as { error?: string }).error;
    if (e !== want.error)
      throw new Error(`${scenarioName} / ${request.id}: expected error="${want.error}", got: ${stringify(body)}`);
    return;
  }
  if (want.length !== undefined) {
    if (!Array.isArray(body) || body.length !== want.length)
      throw new Error(`${scenarioName} / ${request.id}: expected array of length ${want.length}, got: ${stringify(body)}`);
  }
  if (want.ids) {
    if (!Array.isArray(body)) throw new Error(`${scenarioName} / ${request.id}: expected array, got: ${stringify(body)}`);
    const actualIds = (body as Array<Record<string, unknown>>).map((r) => r["id"]);
    if (stringify(actualIds) !== stringify(want.ids))
      throw new Error(`${scenarioName} / ${request.id}: expected ids ${stringify(want.ids)}, got ${stringify(actualIds)}`);
  }
  if (want.names) {
    if (!Array.isArray(body)) throw new Error(`${scenarioName} / ${request.id}: expected array, got: ${stringify(body)}`);
    const actualNames = (body as Array<Record<string, unknown>>).map((r) => r["name"]);
    if (stringify(actualNames) !== stringify(want.names))
      throw new Error(`${scenarioName} / ${request.id}: expected names ${stringify(want.names)}, got ${stringify(actualNames)}`);
  }
  if (want.namesUnordered) {
    if (!Array.isArray(body)) throw new Error(`${scenarioName} / ${request.id}: expected array, got: ${stringify(body)}`);
    const actual = (body as Array<Record<string, unknown>>).map((r) => String(r["name"])).sort();
    const wanted = [...want.namesUnordered].map(String).sort();
    if (stringify(actual) !== stringify(wanted))
      throw new Error(`${scenarioName} / ${request.id}: expected names (unordered) ${stringify(wanted)}, got ${stringify(actual)}`);
  }
  if (want.row) {
    const row = body as Record<string, unknown>;
    for (const [k, v] of Object.entries(want.row)) {
      if (stringify(row[k]) !== stringify(v))
        throw new Error(`${scenarioName} / ${request.id}: expected row.${k}=${stringify(v)}, got ${stringify(row[k])}`);
    }
  }
  if (want.hasId) {
    const row = body as Record<string, unknown>;
    if (typeof row["id"] !== "number")
      throw new Error(`${scenarioName} / ${request.id}: expected numeric id in body, got: ${stringify(body)}`);
  }
}

function stringify(v: unknown): string {
  // Stable stringify is overkill here; JSON.stringify with sorted keys via a replacer.
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) sorted[k] = (val as Record<string, unknown>)[k];
      return sorted;
    }
    return val;
  });
}
