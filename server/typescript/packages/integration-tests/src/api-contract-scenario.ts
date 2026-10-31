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
import { xmlInfosetEqual } from "./xml-infoset.ts";

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
  /** Assert the listed RESPONSE fields all equal EACH OTHER (never a literal) —
   *  format-agnostic. Used by @autoSet scenarios to prove two stamped columns
   *  hold the same value without pinning the exact timestamp. */
  fieldsEqual?: string[];
  /** Assert the two listed RESPONSE fields differ from EACH OTHER (never a
   *  literal) — format-agnostic. Used by autoset-patch to prove a PATCH bumped
   *  autoUpdatedAt (onUpdate) while leaving autoCreatedAt (onCreate) untouched. */
  fieldsNotEqual?: string[];
  envelope?: boolean;
  rowsLength?: number;
  total?: number;
  error?: string;
  field?: string;
  empty?: boolean;
  /** The exact response text (UTF-8), for a CSV export. */
  text?: string;
  /** The response as an XML infoset: names, attributes, text and order; the declaration and
   *  whitespace between elements are not significant. */
  xml?: string;
}

export interface ExpectBlock {
  status: number;
  /** Lower-cased header name to its exact value; `null` means the header is absent. */
  headers?: Record<string, string | null>;
  body?: ExpectBody;
}

export interface ApiRequest {
  id: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
  /** Headers sent with the request. */
  headers?: Record<string, string>;
  expect: ExpectBlock;
}

export interface ApiScenario {
  name: string;
  description?: string | undefined;
  setup?: { truncate?: boolean } | undefined;
  /**
   * The engines that run this scenario (`postgres`, `mysql`, `sqlite`, `d1`), or undefined for
   * every engine the lane has. A scenario whose subject an engine cannot hold (an exact decimal
   * on SQLite, W4) says so here, once, instead of a runner skipping it by name.
   */
  engines?: string[] | undefined;
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
    engines: raw["engines"] as string[] | undefined,
    requests: requests.map((r) => ({
      id: String(r["id"]),
      method: String(r["method"]).toUpperCase() as HttpMethod,
      path: String(r["path"]),
      body: r["body"],
      ...(r["headers"] !== undefined && { headers: r["headers"] as Record<string, string> }),
      expect: r["expect"] as ExpectBlock,
    })),
    sourcePath: file,
  };
}

/**
 * Send every request of a scenario against `baseUrl` and assert each response. Engine-neutral:
 * shared by the report lane's variants (SQLite, D1, MySQL) so the request envelope lives once —
 * the Postgres lane's own copy predates this and is the cross-port runner's reference.
 */
export async function runScenario(
  scenario: ApiScenario,
  baseUrl: string,
  check?: (req: ApiRequest, status: number, bodyText: string) => void,
): Promise<void> {
  for (const req of scenario.requests) {
    const init: RequestInit = { method: req.method };
    const headers: Record<string, string> = { ...req.headers };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    }
    if (Object.keys(headers).length > 0) init.headers = headers;
    const res = await fetch(baseUrl + req.path, init);
    const bodyText = await res.text();
    assertResponseFull(scenario.name, req, res.status, bodyText, (name) => res.headers.get(name));
    check?.(req, res.status, bodyText);
  }
}

/**
 * Assert one response from its raw parts: status, then headers, then the body (JSON-parsed
 * exactly, or kept as text when it is not JSON). `header` reads a response header by name.
 */
export function assertResponseFull(
  scenarioName: string,
  req: ApiRequest,
  status: number,
  bodyText: string,
  header: (name: string) => string | null,
): void {
  let body: unknown = null;
  if (bodyText.length > 0) {
    try { body = parseBodyExact(bodyText); } catch { body = bodyText; }
  }
  assertResponse(scenarioName, req, status, body, bodyText);
  for (const [name, want] of Object.entries(req.expect.headers ?? {})) {
    const got = header(name.toLowerCase());
    if (got !== want) {
      throw new Error(`${scenarioName} / ${req.id}: expected header ${name}=${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
}

/** Stands in for a JSON number whose token a double cannot hold; it equals no expectation. */
export interface InexactNumber { readonly inexactNumber: string }

/**
 * Whether `value` (the double a parser made of `source`) is the number `source` spells. A decimal
 * point and trailing fraction zeros are spelling; a digit the double dropped is not.
 */
function isExact(value: number, source: string): boolean {
  if (Number.isSafeInteger(value) && /^-?\d+$/.test(source)) return true;
  const plain = String(value);
  if (/[eE]/.test(plain) || /[eE]/.test(source)) return false;
  const trimmed = source.includes(".") ? source.replace(/0+$/, "").replace(/\.$/, "") : source;
  return plain === trimmed;
}

/**
 * JSON.parse that does not let a number lose digits unnoticed. The assertion engine compares
 * parsed values, so `12345678901234567.89` arriving as a JSON number would parse to a double and
 * equal an expectation written with the same double, however wrong the server's digits were. A
 * number whose token the double cannot reproduce is returned as an {@link InexactNumber}, which
 * equals nothing the scenarios can write, so the comparison fails and names the token.
 */
export function parseBodyExact(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context?.source !== undefined && !isExact(value, context.source)) {
      return { inexactNumber: context.source } satisfies InexactNumber;
    }
    return value;
  } as Parameters<typeof JSON.parse>[1]);
}

// ---------------------------------------------------------------------------
// Assertion engine
// ---------------------------------------------------------------------------

export function assertResponse(
  scenarioName: string,
  request: ApiRequest,
  status: number,
  body: unknown,
  bodyText?: string,
): void {
  if (status !== request.expect.status) {
    throw new Error(
      `${scenarioName} / ${request.id}: expected status ${request.expect.status}, got ${status}; body: ${stringify(body)}`,
    );
  }
  const want = request.expect.body;
  if (!want) return;

  if (want.text !== undefined) {
    if (bodyText !== want.text)
      throw new Error(`${scenarioName} / ${request.id}: text mismatch\n  expected: ${JSON.stringify(want.text)}\n  actual:   ${JSON.stringify(bodyText)}`);
    return;
  }
  if (want.xml !== undefined) {
    if (bodyText === undefined || !xmlInfosetEqual(bodyText, want.xml))
      throw new Error(`${scenarioName} / ${request.id}: xml mismatch\n  expected: ${want.xml}\n  actual:   ${bodyText}`);
    return;
  }

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
    // `field` is part of the error envelope for the four filter/sort codes and is
    // REQUIRED there (docs/features/api-contract.md, "Error response"). It is
    // asserted inside the `error` branch rather than as a sibling key because that
    // branch RETURNS — a scenario that declared both would otherwise have its
    // `field` silently skipped, which is the same un-gateable shape F20 closed.
    if (want.field !== undefined) {
      const f = (body as { field?: string }).field;
      if (f !== want.field)
        throw new Error(`${scenarioName} / ${request.id}: expected field="${want.field}", got: ${stringify(body)}`);
    }
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
  if (want.fieldsEqual) {
    const row = body as Record<string, unknown>;
    // Compare the raw response fields to EACH OTHER (format-agnostic) — every
    // listed field must serialize identically to the first one.
    const first = stringify(row[want.fieldsEqual[0]!]);
    for (const f of want.fieldsEqual) {
      if (stringify(row[f]) !== first)
        throw new Error(
          `${scenarioName} / ${request.id}: expected fields [${want.fieldsEqual.join(", ")}] to be equal, got ${stringify(
            Object.fromEntries(want.fieldsEqual.map((k) => [k, row[k]])),
          )}`,
        );
    }
  }
  if (want.fieldsNotEqual) {
    if (want.fieldsNotEqual.length !== 2)
      throw new Error(`${scenarioName} / ${request.id}: fieldsNotEqual must list exactly two field names`);
    const row = body as Record<string, unknown>;
    const [a, b] = want.fieldsNotEqual as [string, string];
    // Compare the two raw response fields to EACH OTHER (never a literal).
    if (stringify(row[a]) === stringify(row[b]))
      throw new Error(
        `${scenarioName} / ${request.id}: expected fields ${a} and ${b} to differ, but both = ${stringify(row[a])}`,
      );
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
