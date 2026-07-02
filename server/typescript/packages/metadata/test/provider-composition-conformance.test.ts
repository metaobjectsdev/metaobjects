// Provider-composition conformance — TS reference runner.
//
// Five registry/provider error codes are Tier-1 cross-port invariants that the
// metadata-input → error corpus (fixtures/conformance/error-*) cannot reach:
// they are triggered by HOW providers are composed and sealed, not by any
// metadata document. This runner gates them from the shared corpus at
// fixtures/provider-composition-conformance/.
//
// Each port supplies the SAME canonical named-provider set (see the corpus
// README). A manifest names providers by id; the runner maps names → provider
// objects, composes, and asserts the surfaced .code. The registry-sealed
// scenario composes, seals, then runs a probe provider's registerTypes against
// the sealed registry.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { MetaDataTypeProvider } from "../src/provider.js";
import { composeRegistry } from "../src/provider.js";
import { TypeRegistry, TypeId } from "../src/registry.js";
import { MetaTemplate } from "../src/template/meta-template.js";
import { TYPE_TEMPLATE, TYPE_ATTR } from "../src/shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";
import { ATTR_SUBTYPE_STRING } from "../src/core/attr/attr-constants.js";

// The corpus lives at the REPO ROOT — five `../` levels up from test/
// (test → metadata → packages → typescript → server → repo-root).
const CORPUS = join(
  import.meta.dir,
  "../../../../../fixtures/provider-composition-conformance",
);

// ---------------------------------------------------------------------------
// Canonical named-provider set (see the corpus README). Test-only — these live
// in conformance test code, never in shipped metamodel providers. Every port
// supplies an identical set (same id / dependencies / registration behavior) so
// a manifest's `providers` list resolves identically everywhere.
// ---------------------------------------------------------------------------

const CONFLICT_SUBTYPE = "compositionprobe"; // fresh, otherwise-unused template subtype
const CONFLICT_ATTR = "conflictAttr";

/** No-op provider whose reported id collides with `duplicate-x-clone`. */
const duplicateXProvider: MetaDataTypeProvider = {
  id: "duplicate-x",
  registerTypes() {},
};
/** A second provider whose real `.id` is also "duplicate-x" (map key differs). */
const duplicateXCloneProvider: MetaDataTypeProvider = {
  id: "duplicate-x",
  registerTypes() {},
};

/** Declares a dependency on a non-existent id. */
const dependsOnMissingProvider: MetaDataTypeProvider = {
  id: "depends-on-missing",
  dependencies: ["does-not-exist"],
  registerTypes() {},
};

/** Two providers that name each other — a dependency cycle. */
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

/** Registers a fresh test-only type carrying a single `conflictAttr` string attr. */
const attrConflictBaseProvider: MetaDataTypeProvider = {
  id: "attr-conflict-base",
  registerTypes(registry: TypeRegistry) {
    registry.register({
      typeId: new TypeId(TYPE_TEMPLATE, CONFLICT_SUBTYPE),
      description: "Test-only — provider-composition conflict probe.",
      factory: (typeId, name) => new MetaTemplate(typeId, name),
      childRules: [
        {
          childType: TYPE_ATTR,
          childSubType: CHILD_RULE_WILDCARD,
          childName: CHILD_RULE_WILDCARD,
        },
      ],
      attributes: [
        { name: CONFLICT_ATTR, valueType: ATTR_SUBTYPE_STRING, description: "Conflict probe attr." },
      ],
    });
  },
};

/** Extends the base's type, redefining the same attr name — attr conflict. */
const attrConflictClashProvider: MetaDataTypeProvider = {
  id: "attr-conflict-clash",
  dependencies: ["attr-conflict-base"],
  registerTypes(registry: TypeRegistry) {
    registry.extend(TYPE_TEMPLATE, CONFLICT_SUBTYPE, {
      attributes: [
        { name: CONFLICT_ATTR, valueType: ATTR_SUBTYPE_STRING, description: "Redefined — collides." },
      ],
    });
  },
};

/** Probe: attempts a mutating registration — throws when run against a sealed registry. */
const sealProbeProvider: MetaDataTypeProvider = {
  id: "seal-probe",
  registerTypes(registry: TypeRegistry) {
    registry.register({
      typeId: new TypeId(TYPE_TEMPLATE, "sealprobe"),
      description: "Test-only — sealed-registry mutation probe.",
      factory: (typeId, name) => new MetaTemplate(typeId, name),
      childRules: [],
      attributes: [],
    });
  },
};

const PROVIDERS: Readonly<Record<string, MetaDataTypeProvider>> = {
  "duplicate-x": duplicateXProvider,
  "duplicate-x-clone": duplicateXCloneProvider,
  "depends-on-missing": dependsOnMissingProvider,
  "cycle-a": cycleAProvider,
  "cycle-b": cycleBProvider,
  "attr-conflict-base": attrConflictBaseProvider,
  "attr-conflict-clash": attrConflictClashProvider,
  "seal-probe": sealProbeProvider,
};

interface Manifest {
  description?: string;
  providers: string[];
  expectedError: string;
  sealThenRegister?: string;
}

/** Pull the stable ERR_ code off a caught error, if it carries one. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_UNKNOWN";
}

function resolve(id: string): MetaDataTypeProvider {
  const provider = PROVIDERS[id];
  if (provider === undefined) {
    throw new Error(`Unknown named provider "${id}" in provider-composition corpus`);
  }
  return provider;
}

const manifestFiles = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("provider-composition corpus is non-empty (guards against a mis-pathed CORPUS)", () => {
  expect(manifestFiles.length).toBeGreaterThan(0);
});

for (const file of manifestFiles) {
  test(`provider-composition: ${file}`, async () => {
    const manifest: Manifest = await Bun.file(join(CORPUS, file)).json();
    const providers = manifest.providers.map(resolve);

    if (manifest.sealThenRegister !== undefined) {
      // Compose (must succeed), seal, then run the probe against the sealed registry.
      const registry = composeRegistry(providers);
      registry.seal();
      const probe = resolve(manifest.sealThenRegister);
      let caught: unknown;
      try {
        probe.registerTypes(registry);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(errorCode(caught)).toBe(manifest.expectedError);
      return;
    }

    // Ordinary scenario: the compose call itself throws.
    let caught: unknown;
    try {
      composeRegistry(providers);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(errorCode(caught)).toBe(manifest.expectedError);
  });
}
