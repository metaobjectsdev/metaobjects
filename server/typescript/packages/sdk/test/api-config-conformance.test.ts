// The cross-port `api` setting, run through TypeScript's own config reader: every valid block in
// fixtures/api-contract-conformance/api-settings/config-blocks.json resolves to the corpus's
// values, and every invalid one is refused when the config is read.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigSchema, apiPaginationFromConfig, apiUnknownFieldsFromConfig } from "../src/config.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/api-contract-conformance/api-settings/config-blocks.json");

interface ApiCase {
  name: string;
  api: unknown;
  pagination: { defaultLimit: number; maxLimit: number } | null;
  unknownFields: "reject" | "drop";
}
const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as { cases: ApiCase[]; invalid: { name: string; api: unknown }[] };

function configFor(api: unknown): Record<string, unknown> {
  return api === null ? { schema_version: 1 } : { schema_version: 1, api };
}

describe("api config conformance", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: resolves to the corpus values`, () => {
      const cfg = ConfigSchema.parse(configFor(c.api));
      expect(apiPaginationFromConfig(cfg) ?? null).toEqual(c.pagination);
      // An absent unknownFields is the default, reject.
      expect(apiUnknownFieldsFromConfig(cfg) ?? "reject").toBe(c.unknownFields);
    });
  }

  for (const c of corpus.invalid) {
    test(`${c.name}: the config is refused when read`, () => {
      expect(ConfigSchema.safeParse(configFor(c.api)).success).toBe(false);
    });
  }
});
