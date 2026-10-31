// The real validators the contract corpus runs the emitted documents through: Ajv in its strict
// mode for JSON Schema 2020-12, with the standard formats, and a validator of the OpenAPI 3.1
// specification's own schema. Neither knows anything about MetaObjects, which is the point.

import { Validator } from "@seriousme/openapi-schema-validator";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export type JsonDoc = Record<string, unknown>;

/** A strict Ajv holding every canonical schema of a tree, so relative `$ref`s resolve. */
export function ajvOver(schemas: readonly JsonDoc[]): Ajv2020 {
  // `allowUnionTypes`: `["string", "null"]` is plain 2020-12, and Ajv's strictTypes only logs it.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  addFormats(ajv as never); // ajv-formats resolves its own ajv: the instance is the same shape
  for (const schema of schemas) ajv.addSchema(schema);
  return ajv;
}

export async function openApiErrors(doc: JsonDoc): Promise<unknown[]> {
  const result = await new Validator().validate(doc);
  return result.valid ? [] : (result.errors as unknown[]);
}

/** The only keywords a strict schema may use, anywhere in it. */
const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  "title", "description", "type", "properties", "required", "additionalProperties", "items", "enum",
]);

/** Every way a strict schema leaves the subset: empty when it holds. */
export function strictViolations(schema: JsonDoc, at = "#"): string[] {
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!STRICT_KEYWORDS.has(key)) found.push(`${at}: keyword '${key}'`);
  }
  const type = schema["type"];
  const named = Array.isArray(type) ? type.filter((t) => t !== "null") : [type];
  if (named.length !== 1) found.push(`${at}: type ${JSON.stringify(type)} is not one type, plus null`);
  if (named[0] === "object") {
    const properties = (schema["properties"] ?? {}) as Record<string, JsonDoc>;
    if (schema["additionalProperties"] !== false) found.push(`${at}: an object is not closed`);
    const required = (schema["required"] ?? []) as string[];
    if ([...required].sort().join() !== Object.keys(properties).sort().join()) found.push(`${at}: not every property is required`);
    for (const [name, value] of Object.entries(properties)) found.push(...strictViolations(value, `${at}/${name}`));
  }
  if (named[0] === "array") found.push(...strictViolations(schema["items"] as JsonDoc, `${at}/items`));
  return found;
}
