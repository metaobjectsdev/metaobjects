// adapter.ts — the TypeScript port's ConformanceAdapter implementation.
//
// Binds the metadata package's typed-tree API to the neutral
// ConformanceAdapter interface from @metaobjectsdev/conformance.

import type {
  ConformanceAdapter,
  ErrorEnvelopeRecord,
  LoadOutcome,
  NodeHandle,
  NormalizedResult,
  TreeHandle,
} from "@metaobjectsdev/conformance";
import { UnknownCapabilityError } from "@metaobjectsdev/conformance";
import { relative } from "node:path";
import type { MetaDataTypeProvider } from "../../src/provider.js";
import { composeRegistry } from "../../src/provider.js";
import { coreTypesProvider } from "../../src/core-types.js";
import { dbProvider } from "../../src/persistence/db/db-provider.js";
import { docProvider } from "../../src/core/documentation/doc-provider.js";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import type { MetaData } from "../../src/shared/meta-data.js";
import { canonicalSerialize, canonicalSerializeEffective } from "../../src/serializer-json.js";
import { ParseError } from "../../src/errors.js";
import { TypeId } from "../../src/registry.js";
import { MetaTemplate } from "../../src/template/meta-template.js";
import { TYPE_TEMPLATE, TYPE_ATTR } from "../../src/shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "../../src/shared/structural.js";
import { ATTR_SUBTYPE_STRING } from "../../src/core/attr/attr-constants.js";
import { navigate } from "./navigator.js";
import { binding } from "./binding.js";

// ---------------------------------------------------------------------------
// Test-only providers exercised by the provider-extension-* fixtures.
//
// These are NOT shipped — they live in test code to verify the cross-port
// composition contract end-to-end. Each adapter (TS / C# / Python) carries
// the same set so fixture-declared provider ids resolve identically.
// ---------------------------------------------------------------------------

/**
 * Adds a hypothetical `template.briefing` subtype with @payloadRef + @author
 * + @recipient. Fictional — not a real template kind that MO core ships. Used
 * only by the provider-extension-* fixtures to exercise the registry.register
 * machinery without colliding with real core subtypes.
 *
 * (Pre-ADR-0011 this fixture-only subtype was named "toolcall"; now that
 * template.toolcall is a real core subtype the test-only one had to move to
 * a different name so the fixture still meaningfully tests "registering a
 * NEW subtype works".)
 */
const wizardsTemplateBriefingProvider: MetaDataTypeProvider = {
  id: "wizards-template-briefing",
  dependencies: ["metaobjects-core-types"],
  description: "Test-only — registers a fictional template.briefing subtype.",
  registerTypes(registry) {
    registry.register({
      typeId: new TypeId(TYPE_TEMPLATE, "briefing"),
      description: "Hypothetical briefing template — test-only.",
      factory: (typeId, name) => new MetaTemplate(typeId, name),
      childRules: [
        {
          childType: TYPE_ATTR,
          childSubType: CHILD_RULE_WILDCARD,
          childName: CHILD_RULE_WILDCARD,
        },
      ],
      attributes: [
        { name: "payloadRef", valueType: ATTR_SUBTYPE_STRING, required: true, description: "Briefing-input payload reference." },
        { name: "author",     valueType: ATTR_SUBTYPE_STRING, required: true, description: "Author of the briefing." },
        { name: "recipient",  valueType: ATTR_SUBTYPE_STRING, required: true, description: "Intended recipient role." },
      ],
    });
  },
};

/** Two providers that name each other as a dependency — surfaces ERR_PROVIDER_DEPENDENCY_CYCLE. */
const cycleAProvider: MetaDataTypeProvider = {
  id: "cycle-a",
  dependencies: ["cycle-b"],
  registerTypes() {},
};
const cycleBProvider: MetaDataTypeProvider = {
  id: "cycle-b",
  dependencies: ["cycle-a"],
  registerTypes() {},
};

/** Provider declaring a dependency on a non-existent id — surfaces ERR_PROVIDER_MISSING_DEPENDENCY. */
const dependsOnMissingProvider: MetaDataTypeProvider = {
  id: "depends-on-missing",
  dependencies: ["does-not-exist"],
  registerTypes() {},
};

/** A pair that report the same id from two provider objects — surfaces ERR_PROVIDER_DUPLICATE_ID. */
const duplicateXProvider: MetaDataTypeProvider = {
  id: "duplicate-x",
  registerTypes() {},
};
// A second provider whose ALIAS-LIKE registered id collides with duplicate-x.
// Its lookup key in the adapter PROVIDERS map is "duplicate-x-clone", but its
// real `.id` is the same "duplicate-x" — the collision surfaces at compose.
const duplicateXCloneProvider: MetaDataTypeProvider = {
  id: "duplicate-x",
  registerTypes() {},
};

/**
 * Provider-id → provider object. The fixture corpus names providers by their
 * stable `id` (e.g. "metaobjects-core-types"). loadFixture maps those ids to
 * the actual provider objects to compose a registry. Test-only providers
 * (suffixed below) feed the provider-extension-* fixtures.
 */
const PROVIDERS: Readonly<Record<string, MetaDataTypeProvider>> = {
  [coreTypesProvider.id]: coreTypesProvider, // "metaobjects-core-types"
  [dbProvider.id]: dbProvider,               // "metaobjects-db"
  [docProvider.id]: docProvider,             // "metaobjects-documentation"
  // Test-only — provider-extension-* fixtures.
  "wizards-template-briefing": wizardsTemplateBriefingProvider,
  "cycle-a": cycleAProvider,
  "cycle-b": cycleBProvider,
  "depends-on-missing": dependsOnMissingProvider,
  "duplicate-x": duplicateXProvider,
  "duplicate-x-clone": duplicateXCloneProvider,
};

/** Pull a `.code` off a collected loader error, if it carries one. */
function errorCode(err: Error): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_UNKNOWN";
}

export const tsAdapter: ConformanceAdapter = {
  language: "typescript",

  async loadFixture(
    inputDir: string,
    providers: readonly string[],
  ): Promise<LoadOutcome> {
    const resolved: MetaDataTypeProvider[] = providers.map((id) => {
      const provider = PROVIDERS[id];
      if (provider === undefined) {
        throw new Error(`Unknown provider id "${id}"`);
      }
      return provider;
    });
    // Provider composition errors (duplicate id / missing dep / cycle) are
    // first-class fixture outcomes: surface them as a code-only LoadOutcome
    // so the cross-port runner can compare expected-errors.json directly.
    let registry;
    try {
      registry = composeRegistry(resolved);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const codeStr = typeof code === "string" ? code : "ERR_UNKNOWN";
      const compErr: ErrorEnvelopeRecord = {
        code: codeStr,
        source: { format: "code", files: [] },
      };
      return {
        tree: undefined as unknown as TreeHandle,
        errorCodes: [codeStr],
        warnings: [],
        errors: [compErr],
        warningEnvelopes: [],
      };
    }
    const result = await MetaDataLoader.fromDirectory(inputDir, { registry });
    // FR5a — surface the full ParseError envelopes; normalize files[] to be
    // relative to the fixture's inputDir so the cross-port assertion has a
    // portable file token. Errors without an envelope (rare; only non-ParseError)
    // synthesize a minimal $-rooted shape.
    function relativize(f: string): string {
      const fwd = f.replace(/\\/g, "/");
      return f.startsWith(inputDir) ? relative(inputDir, f).replace(/\\/g, "/") : fwd;
    }
    const envelopes: ErrorEnvelopeRecord[] = result.errors.map((err) => {
      if (err instanceof ParseError) {
        const src = err.source;
        if (src.format === "json" || src.format === "yaml"
          || src.format === "merged" || src.format === "resolved") {
          const files = src.files.map(relativize);
          const jp = (src as { jsonPath?: string }).jsonPath;
          // FR5d — surface referrer + target on resolved envelopes so the
          // cross-port runner can assert byte-identical envelopes across all
          // four ports.
          const referrer = (src as { referrer?: string }).referrer;
          const target = (src as { target?: string }).target;
          const source: ErrorEnvelopeRecord["source"] = {
            format: src.format,
            files,
            ...(jp !== undefined ? { jsonPath: jp } : {}),
            ...(referrer !== undefined ? { referrer } : {}),
            ...(target !== undefined ? { target } : {}),
          };
          return { code: err.code, source };
        }
        return { code: err.code, source: { format: src.format, files: [] } };
      }
      const code = (err as { code?: unknown }).code;
      return {
        code: typeof code === "string" ? code : "ERR_UNKNOWN",
        source: { format: "json", files: [], jsonPath: "$" },
      };
    });
    // FR5c-finalize — surface warning envelopes (same envelope shape as
    // errors). Loader warnings already carry full `LoaderWarning` envelopes;
    // mirror the error-envelope normalization (relativize files; preserve
    // jsonPath / referrer / target when present on the source variant).
    const warningEnvelopes: ErrorEnvelopeRecord[] = result.warnings.map((w) => {
      const src = w.source;
      if (src.format === "json" || src.format === "yaml"
        || src.format === "merged" || src.format === "resolved") {
        const files = src.files.map(relativize);
        const jp = (src as { jsonPath?: string }).jsonPath;
        const referrer = (src as { referrer?: string }).referrer;
        const target = (src as { target?: string }).target;
        const source: ErrorEnvelopeRecord["source"] = {
          format: src.format,
          files,
          ...(jp !== undefined ? { jsonPath: jp } : {}),
          ...(referrer !== undefined ? { referrer } : {}),
          ...(target !== undefined ? { target } : {}),
        };
        return { code: w.code, source };
      }
      return { code: w.code, source: { format: src.format, files: [] } };
    });
    return {
      tree: result.root,
      errorCodes: result.errors.map(errorCode),
      // ConformanceAdapter.LoadOutcome.warnings is `string[]`; the loader now
      // returns LoaderWarning envelopes (FR5a). Extract the human-readable
      // message for cross-port string-equality comparison.
      warnings: result.warnings.map((w) => w.message),
      errors: envelopes,
      warningEnvelopes,
    };
  },

  canonicalSerialize(tree: TreeHandle): string {
    return canonicalSerialize(tree as MetaData);
  },

  canonicalSerializeEffective(tree: TreeHandle): string {
    return canonicalSerializeEffective(tree as MetaData);
  },

  navigate(tree: TreeHandle, path: readonly string[]): NodeHandle | undefined {
    return navigate(tree as MetaData, path);
  },

  invoke(
    node: NodeHandle,
    capabilityId: string,
    args: Record<string, string | number | boolean>,
  ): NormalizedResult {
    const fn = binding[capabilityId];
    if (fn === undefined) {
      throw new UnknownCapabilityError(capabilityId);
    }
    return fn(node as MetaData, args);
  },
};
