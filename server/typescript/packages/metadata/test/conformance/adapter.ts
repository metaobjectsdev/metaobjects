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
import { navigate } from "./navigator.js";
import { binding } from "./binding.js";

/**
 * Provider-id → provider object. The fixture corpus names providers by their
 * stable `id` (e.g. "metaobjects-core-types"). loadFixture maps those ids to
 * the actual provider objects to compose a registry.
 */
const PROVIDERS: Readonly<Record<string, MetaDataTypeProvider>> = {
  [coreTypesProvider.id]: coreTypesProvider, // "metaobjects-core-types"
  [dbProvider.id]: dbProvider,               // "metaobjects-db"
  [docProvider.id]: docProvider,             // "metaobjects-documentation"
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
    const registry = composeRegistry(resolved);
    const result = await MetaDataLoader.fromDirectory(inputDir, { registry });
    // FR5a — surface the full ParseError envelopes; normalize files[] to be
    // relative to the fixture's inputDir so the cross-port assertion has a
    // portable file token. Errors without an envelope (rare; only non-ParseError)
    // synthesize a minimal $-rooted shape.
    const envelopes: ErrorEnvelopeRecord[] = result.errors.map((err) => {
      if (err instanceof ParseError) {
        const src = err.source;
        if (src.format === "json" || src.format === "yaml") {
          const files = src.files.map((f) => {
            if (f.startsWith(inputDir)) return relative(inputDir, f).replace(/\\/g, "/");
            return f.replace(/\\/g, "/");
          });
          return { code: err.code, source: { format: src.format, files, jsonPath: src.jsonPath } };
        }
        if (src.format === "merged" || src.format === "resolved") {
          const files = src.files.map((f) => {
            if (f.startsWith(inputDir)) return relative(inputDir, f).replace(/\\/g, "/");
            return f.replace(/\\/g, "/");
          });
          const jp = (src as { jsonPath?: string }).jsonPath;
          return { code: err.code, source: jp !== undefined ? { format: src.format, files, jsonPath: jp } : { format: src.format, files } };
        }
        return { code: err.code, source: { format: src.format, files: [] } };
      }
      const code = (err as { code?: unknown }).code;
      return {
        code: typeof code === "string" ? code : "ERR_UNKNOWN",
        source: { format: "json", files: [], jsonPath: "$" },
      };
    });
    return {
      tree: result.root,
      errorCodes: result.errors.map(errorCode),
      // ConformanceAdapter.LoadOutcome.warnings is `string[]`; the loader now
      // returns LoaderWarning envelopes (FR5a). Extract the human-readable
      // message for cross-port string-equality comparison.
      warnings: result.warnings.map((w) => w.message),
      errors: envelopes,
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
