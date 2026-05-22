// adapter.ts — the TypeScript port's ConformanceAdapter implementation.
//
// Binds the metadata package's typed-tree API to the neutral
// ConformanceAdapter interface from @metaobjectsdev/conformance.

import type {
  ConformanceAdapter,
  LoadOutcome,
  NodeHandle,
  NormalizedResult,
  TreeHandle,
} from "@metaobjectsdev/conformance";
import { UnknownCapabilityError } from "@metaobjectsdev/conformance";
import type { MetaDataTypeProvider } from "../../src/provider.js";
import { composeRegistry } from "../../src/provider.js";
import { coreTypesProvider } from "../../src/core-types.js";
import { dbProvider } from "../../src/db/db-provider.js";
import { FileMetaDataLoader } from "../../src/core/file-meta-data-loader.js";
import type { MetaData } from "../../src/meta/meta-data.js";
import { canonicalSerialize, canonicalSerializeEffective } from "../../src/serializer-json.js";
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
    const result = await new FileMetaDataLoader({ registry }).loadDirectory(
      inputDir,
    );
    return {
      tree: result.root,
      errorCodes: result.errors.map(errorCode),
      warnings: result.warnings,
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
