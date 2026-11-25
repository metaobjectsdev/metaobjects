// Wrangler's own verdict on a configuration, for the tests that write one. The schema is
// vendored in wrangler-schema/ (its README says from which version and how to move it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "wrangler-schema/config-schema.json"), "utf8"));
// strict: false — the schema carries Wrangler's own `allowTrailingCommas` keyword.
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

/** Each error Wrangler's schema reports for `config`, at its path: [] when it accepts the configuration. */
export function wranglerSchemaErrors(config: unknown): string[] {
  return validate(config) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
