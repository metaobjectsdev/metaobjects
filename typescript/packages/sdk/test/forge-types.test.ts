import { describe, test, expect } from "bun:test";
import {
  FORGE_TYPE_DECISION,
  FORGE_TYPE_PRINCIPLE,
  FORGE_TYPE_CONVENTION,
  FORGE_TYPE_GLOSSARY,
  FORGE_TYPE_FAILURE,
  FORGE_TYPES,
  FORGE_ATTR_CONFIDENCE,
  FORGE_ATTR_SOURCE,
  FORGE_ATTR_CAPTURED_AT,
  FORGE_ATTR_LAST_VALIDATED_COMMIT,
  FORGE_ATTR_PRIMARY_LOCATION,
  FORGE_ATTR_OCCURRENCES,
  FORGE_ATTR_RATIONALE,
  FORGE_ATTR_ALTERNATIVES,
  FORGE_ATTR_SCOPE,
  FORGE_ATTR_STATEMENT,
  FORGE_ATTR_ENFORCEMENT,
  FORGE_ATTR_PATTERN_DESCRIPTION,
  FORGE_ATTR_EXAMPLES,
  FORGE_ATTR_COUNTER_EXAMPLES,
  FORGE_ATTR_APPLIES_TO,
  FORGE_ATTR_TERM,
  FORGE_ATTR_SYNONYMS,
  FORGE_ATTR_DEFINITION,
  FORGE_ATTR_CODE_ANCHORS,
  FORGE_ATTR_SEE_ALSO,
  FORGE_ATTR_WHAT_WAS_TRIED,
  FORGE_ATTR_WHY_IT_FAILED,
  FORGE_ATTRS,
} from "../src/forge-types.js";

describe("FORGE_TYPE_* constants", () => {
  test("all five descriptive types are exported with expected names", () => {
    expect(FORGE_TYPE_DECISION).toBe("decision");
    expect(FORGE_TYPE_PRINCIPLE).toBe("principle");
    expect(FORGE_TYPE_CONVENTION).toBe("convention");
    expect(FORGE_TYPE_GLOSSARY).toBe("glossary");
    expect(FORGE_TYPE_FAILURE).toBe("failure");
  });

  test("FORGE_TYPES exports the closed set", () => {
    expect(FORGE_TYPES).toEqual([
      "decision",
      "principle",
      "convention",
      "glossary",
      "failure",
    ]);
  });
});

describe("FORGE_ATTR_* constants", () => {
  test("camelCase, forge-prefixed, no separator", () => {
    expect(FORGE_ATTR_CONFIDENCE).toBe("forgeConfidence");
    expect(FORGE_ATTR_SOURCE).toBe("forgeSource");
    expect(FORGE_ATTR_CAPTURED_AT).toBe("forgeCapturedAt");
    expect(FORGE_ATTR_LAST_VALIDATED_COMMIT).toBe("forgeLastValidatedCommit");
    expect(FORGE_ATTR_PRIMARY_LOCATION).toBe("forgePrimaryLocation");
    expect(FORGE_ATTR_OCCURRENCES).toBe("forgeOccurrences");
    expect(FORGE_ATTR_RATIONALE).toBe("forgeRationale");
    expect(FORGE_ATTR_ALTERNATIVES).toBe("forgeAlternatives");
    expect(FORGE_ATTR_SCOPE).toBe("forgeScope");
    expect(FORGE_ATTR_STATEMENT).toBe("forgeStatement");
    expect(FORGE_ATTR_ENFORCEMENT).toBe("forgeEnforcement");
    expect(FORGE_ATTR_PATTERN_DESCRIPTION).toBe("forgePatternDescription");
    expect(FORGE_ATTR_EXAMPLES).toBe("forgeExamples");
    expect(FORGE_ATTR_COUNTER_EXAMPLES).toBe("forgeCounterExamples");
    expect(FORGE_ATTR_APPLIES_TO).toBe("forgeAppliesTo");
    expect(FORGE_ATTR_TERM).toBe("forgeTerm");
    expect(FORGE_ATTR_SYNONYMS).toBe("forgeSynonyms");
    expect(FORGE_ATTR_DEFINITION).toBe("forgeDefinition");
    expect(FORGE_ATTR_CODE_ANCHORS).toBe("forgeCodeAnchors");
    expect(FORGE_ATTR_SEE_ALSO).toBe("forgeSeeAlso");
    expect(FORGE_ATTR_WHAT_WAS_TRIED).toBe("forgeWhatWasTried");
    expect(FORGE_ATTR_WHY_IT_FAILED).toBe("forgeWhyItFailed");
  });

  test("FORGE_ATTRS includes every constant exactly once", () => {
    expect(new Set(FORGE_ATTRS).size).toBe(FORGE_ATTRS.length);
    expect(FORGE_ATTRS).toContain(FORGE_ATTR_CONFIDENCE);
    expect(FORGE_ATTRS).toContain(FORGE_ATTR_WHY_IT_FAILED);
  });
});

import { TypeRegistry, FileMetaDataLoader, MetaModel, TypeId, registerCoreTypes } from "@metaobjects/metadata";
import { registerForgeTypes } from "../src/forge-types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("registerForgeTypes", () => {
  test("registers all five Forge types with base subtype + listed subtypes", () => {
    const reg = new TypeRegistry();
    registerCoreTypes(reg);
    registerForgeTypes(reg);

    expect(reg.has("decision", "base")).toBe(true);
    expect(reg.has("decision", "global")).toBe(true);
    expect(reg.has("decision", "scoped")).toBe(true);
    expect(reg.has("principle", "advisory")).toBe(true);
    expect(reg.has("principle", "enforced")).toBe(true);
    expect(reg.has("convention", "base")).toBe(true);
    expect(reg.has("glossary", "base")).toBe(true);
    expect(reg.has("failure", "base")).toBe(true);
  });

  test("loaded metadata file can contain decision children", async () => {
    const reg = new TypeRegistry();
    registerCoreTypes(reg);
    registerForgeTypes(reg);

    const dir = mkdtempSync(join(tmpdir(), "forge-types-load-"));
    try {
      const path = join(dir, "test.json");
      writeFileSync(
        path,
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              {
                decision: {
                  name: "useTanstackQuery",
                  subType: "global",
                  "@forgeConfidence": 0.9,
                  "@forgeSource": "human",
                  "@forgeAlternatives": ["swr", "redux-toolkit-query"],
                },
              },
            ],
          },
        }),
      );

      const loader = new FileMetaDataLoader({ registry: reg });
      const result = await loader.loadFiles([path]);

      expect(result.errors).toHaveLength(0);
      const dec = result.root.children().find((c) => c.type === "decision");
      expect(dec).toBeDefined();
      expect(dec!.name).toBe("useTanstackQuery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("calling twice on the same registry throws (registry protects against duplicate)", () => {
    const reg = new TypeRegistry();
    registerCoreTypes(reg);
    registerForgeTypes(reg);
    expect(() => registerForgeTypes(reg)).toThrow(/duplicate/i);
  });
});
