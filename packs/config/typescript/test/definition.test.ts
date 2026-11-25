// The pack's definition file is its vocabulary, and the embedded copy and the lowering
// are two ways it could drift from what registers. Both are held here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRegistryManifest, composeRegistry, coreProviders, MetaObject, type MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { DEFINITION_JSON, EMBEDDED_TS, renderEmbedded } from "../scripts/embed-definition.js";
import { CONFIG_DEFINITION } from "../src/config-definition.embedded.js";
import type { PackFactory } from "../src/definition.js";
import { configProvider } from "../src/index.js";
import { MetaVault, MetaVaultScope } from "../src/nodes.js";

// Core's own lowering of a definition file (provider-data.ts) is not on its public surface,
// so this test reaches it by path, at run time, as the reference the pack's lowering must
// match. Under bun, @metaobjectsdev/metadata resolves to the same src/ tree, so the registry
// it fills is the one the pack registers into. The path is computed so tsc, which reads
// core's built declarations, never compiles core's sources into this package.
type Apply = (registry: unknown, def: unknown, factories: Record<string, PackFactory>) => void;
const CORE_PROVIDER_DATA = join(import.meta.dir, "..", "..", "..", "..", "server/typescript/packages/metadata/src/provider-data.ts");
const { applyProviderDefinition } = (await import(pathToFileURL(CORE_PROVIDER_DATA).href)) as { applyProviderDefinition: Apply };

describe("config pack definition", () => {
  test("the embedded copy is current (bun run embed)", () => {
    expect(readFileSync(EMBEDDED_TS, "utf8")).toBe(renderEmbedded(readFileSync(DEFINITION_JSON, "utf8")));
  });

  test("registers the same vocabulary core's own lowering would", () => {
    const reference: MetaDataTypeProvider = {
      id: configProvider.id,
      dependencies: configProvider.dependencies ?? [],
      registerTypes(registry) {
        applyProviderDefinition(registry, CONFIG_DEFINITION, {
          "object.settings": (t, n) => new MetaObject(t, n),
          "vault.infisical": (t, n) => new MetaVault(t, n),
          "scope.env": (t, n) => new MetaVaultScope(t, n),
        });
      },
    };
    const ours = buildRegistryManifest(composeRegistry([...coreProviders, configProvider]));
    const theirs = buildRegistryManifest(composeRegistry([...coreProviders, reference]));
    expect(JSON.stringify(ours)).toBe(JSON.stringify(theirs));
  });
});
