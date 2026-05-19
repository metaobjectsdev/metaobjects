import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "../../../fixtures/conformance");

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: {
    command: `METAOBJECTS_CONFORMANCE_CORPUS=${corpus} bun test test/conformance.test.ts`,
  },
  mutate: [
    "src/parser-core.ts",
    "src/super-resolve.ts",
    "src/subtype-rules.ts",
    "src/serializer-json.ts",
    "src/overlay.ts",
    "src/provider.ts",
  ],
  thresholds: { high: 60, low: 40, break: 35 },
  reporters: ["clear-text", "html"],
};
