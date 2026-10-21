// ADR-0058 — a generator option that set column naming apart from the project's one setting is
// refused, in the packaged generator and in the reference copy `meta eject` hands out, with the
// same words every port prints.

import { guideUrl } from "@metaobjectsdev/metadata/release-docs";
// The guide links name the tag of the running release (a prerelease keeps main).
const BLOB = guideUrl("");
import { describe, expect, test } from "bun:test";
import { agentDocsFile as builtinAgentDocs } from "../src/generators/agent-docs-file.js";
import { agentDocsFile as refAgentDocs } from "../src/reference/agent-docs.js";

const REFUSAL =
  'the columnNamingStrategy option of agentDocsFile() was removed in 1.1.0. Column and table naming is one project setting now, read by every port: "naming" in .metaobjects/config.json, for example "naming": { "columns": "kebab-case" }. Move it there and delete the columnNamingStrategy option of agentDocsFile(). See ' + BLOB + 'docs/features/migrations/physical-naming.md';

describe("agentDocsFile({ columnNamingStrategy }) is refused (ADR-0058)", () => {
  for (const [label, factory] of [["packaged", builtinAgentDocs], ["reference copy", refAgentDocs]] as const) {
    test(label, () => {
      const opts = { columnNamingStrategy: "kebab-case" } as unknown as Parameters<typeof factory>[0];
      expect(() => factory(opts)).toThrow(REFUSAL);
      expect(() => factory()).not.toThrow();
    });
  }
});
