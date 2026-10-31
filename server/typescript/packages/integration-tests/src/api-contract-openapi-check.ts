// api-contract-openapi-check.ts — hold a GENERATED server to the document the openapi generator
// writes for it (FR-022). The api-contract corpora assert what a route answers; this asserts the
// document says so: every exchange in a generated lane must be a documented route, every 2xx request
// must be one the document accepts, and every response must match the schema documented for it.
//
// The document under test is the golden in fixtures/contract-conformance/<case>/expected/openapi.json,
// so a server and a document that drift apart fail here even when each passes its own corpus.
// Nothing in it knows about MetaObjects: routes are matched from `paths`, and bodies are validated
// by Ajv through `$ref`s into the document.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ApiRequest } from "./api-contract-scenario.ts";

const CONTRACT_CORPUS_DIR = resolve(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "contract-conformance");
const DOCUMENT_ID = "openapi";
const JSON_MEDIA_TYPE = "application/json";

/**
 * The REST contract's TypeScript-only query extensions (docs/features/api-contract.md, "TS-only
 * filter extensions"). The document states the cross-port contract, so it leaves these out, and a
 * scenario that sends one is outside what this check can hold.
 */
const TS_ONLY_QUERY = /^(search|filter\[(or|and)\])/;

type JsonObject = Record<string, unknown>;

interface Operation {
  parameters?: Array<{ name: string; in: string }>;
  requestBody?: { content?: Record<string, { schema?: JsonObject }> };
  responses: Record<string, { content?: Record<string, { schema?: JsonObject }> }>;
}

type PathItem = Record<string, unknown> & { parameters?: Array<{ name: string; in: string }> };

export type ContractCheck = (req: ApiRequest, status: number, bodyText: string) => void;

function templateRegex(template: string): RegExp {
  return new RegExp(`^${template.split("/").map((part) => (part.startsWith("{") ? "[^/]+" : part)).join("/")}$`);
}

/** A document's path templates, literal ones first: `/x/subtypes` wins over `/x/{id}`. */
function matchers(paths: Record<string, PathItem>): Array<{ template: string; pattern: RegExp }> {
  return Object.keys(paths)
    .sort((a, b) => a.split("{").length - b.split("{").length)
    .map((template) => ({ template, pattern: templateRegex(template) }));
}

function pointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function queryNames(path: string): string[] {
  const at = path.indexOf("?");
  if (at < 0) return [];
  return [...new URLSearchParams(path.slice(at + 1)).keys()];
}

/** A checker over one contract case's golden document. */
export function openApiCheck(caseName: string): ContractCheck {
  const document = JSON.parse(readFileSync(resolve(CONTRACT_CORPUS_DIR, caseName, "expected", "openapi.json"), "utf8")) as {
    paths: Record<string, PathItem>;
  };
  // `strictSchema: false`: OpenAPI's `discriminator` is its own keyword, not JSON Schema's.
  const ajv = new Ajv2020({ strictSchema: false, allowUnionTypes: true, allErrors: true });
  addFormats(ajv as never); // ajv-formats resolves its own ajv: the instance is the same shape
  ajv.addSchema(document as never, DOCUMENT_ID);
  const templates = matchers(document.paths);

  function fail(req: ApiRequest, why: string): never {
    throw new Error(`${caseName}: ${req.method} ${req.path} (${req.id}): ${why}`);
  }

  /** Compiled by its place in the document, so the `$ref`s inside resolve against the document. */
  function validate(req: ApiRequest, what: string, at: string[], value: unknown): void {
    const check = ajv.compile({ $ref: `${DOCUMENT_ID}#/${at.map(pointerToken).join("/")}` });
    if (check(value)) return;
    fail(req, `${what} does not match the document: ${ajv.errorsText(check.errors)}: ${JSON.stringify(value)}`);
  }

  return (req, status, bodyText) => {
    const route = req.path.split("?")[0]!;
    const template = templates.find((t) => t.pattern.test(route))?.template;
    const item = template === undefined ? undefined : document.paths[template];
    const operation = item?.[req.method.toLowerCase()] as Operation | undefined;
    if (operation === undefined) {
      // The document states the routes that exist. A 404 or 405 is the answer to one that does not.
      if (status === 404 || status === 405) return;
      fail(req, `answered ${status} on a route the document does not hold`);
    }
    const at = ["paths", template!, req.method.toLowerCase()];
    const documented = operation.responses[String(status)];
    if (documented === undefined) fail(req, `answered ${status}, which the document does not list`);

    if (status >= 200 && status < 300) {
      const declared = new Set([...(item?.parameters ?? []), ...(operation.parameters ?? [])].map((p) => p.name));
      for (const name of queryNames(req.path)) {
        if (!declared.has(name) && !TS_ONLY_QUERY.test(name)) fail(req, `query parameter '${name}' is not in the document`);
      }
      const request = operation.requestBody?.content?.[JSON_MEDIA_TYPE]?.schema;
      if (request !== undefined && req.body !== undefined) {
        validate(req, "the request body", [...at, "requestBody", "content", JSON_MEDIA_TYPE, "schema"], req.body);
      }
    }

    const response = documented.content?.[JSON_MEDIA_TYPE]?.schema;
    if (response === undefined || bodyText.length === 0) return;
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return; // a CSV or XML export: the document states it by media type, and its bytes are the corpus's
    }
    validate(req, "the response", [...at, "responses", String(status), "content", JSON_MEDIA_TYPE, "schema"], body);
  };
}
