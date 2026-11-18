// validator.atLeastOne takes no @max. The shared fixture error-validator-at-least-one-max-unknown
// runs under the strict loader, where the attribute is unregistered; this runs the same input
// through the default (non-strict) loader too, which would otherwise keep @max and ignore it.
// Oracle: that fixture's expected-errors.json, exactly one ERR_UNKNOWN_ATTR at the validator,
// under either loader.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { ParseError } from "../src/errors.js";

const FIXTURE = join(import.meta.dir, "../../../../../fixtures/conformance/error-validator-at-least-one-max-unknown");

const expected = (JSON.parse(readFileSync(join(FIXTURE, "expected-errors.json"), "utf8")) as {
  errors: { code: string; source: { jsonPath: string } }[];
}).errors.map((e) => [e.code, e.source.jsonPath]);

describe("validator.atLeastOne with @max", () => {
  test.each([false, true])("is refused once (strict: %p)", async (strict) => {
    const { errors } = await MetaDataLoader.fromDirectory(join(FIXTURE, "input"), { strict });
    const actual = errors.map((e) => e instanceof ParseError
      ? [e.code, (e.source as { jsonPath?: string } | undefined)?.jsonPath]
      : [e.message]);
    expect(actual).toEqual(expected);
  });
});
