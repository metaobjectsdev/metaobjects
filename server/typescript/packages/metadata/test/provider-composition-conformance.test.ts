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
import { TYPE_TEMPLATE, TYPE_ATTR, TYPE_VIEW } from "../src/shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";
import { ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_INT } from "../src/core/attr/attr-constants.js";
import { VIEW_SUBTYPE_CURRENCY } from "../src/presentation/view/view-constants.js";
import { coreProviders } from "../src/core-types.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

// The corpus lives at the REPO ROOT — five `../` levels up from test/
// (test → metadata → packages → typescript → server → repo-root).
const CORPUS = join(
  import.meta.dir,
  "../../../../../fixtures/provider-composition-conformance",
);

// #265 — a SECOND, subdir corpus that composes the library's real core provider
// set with a consumer provider and (for two scenarios) strict-loads an actual
// metadata document. Lives in its own subdir (not the flat CORPUS dir) so
// un-updated runners in other ports — which list CORPUS non-recursively and
// hard-require the old manifest shape — are unaffected. See README.md.
const COMPOSE_LOAD_CORPUS = join(CORPUS, "compose-load");

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
        { name: CONFLICT_ATTR, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Conflict probe attr." },
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
        { name: CONFLICT_ATTR, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Redefined — collides." },
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

/**
 * #265 — `compose-load/` canonical named provider. Extends `view.currency` (a
 * SPEC-DECLARED CORE subtype the library's own core-types provider registers)
 * with a new `decimals` int attr. Deliberately NO dependencies — see README.md
 * "Canonical named provider `extend-spec-subtype`" for why (cross-port id/dep
 * parity vs. `composeWithCore` ordering).
 */
const extendSpecSubtypeProvider: MetaDataTypeProvider = {
  id: "extend-spec-subtype",
  registerTypes(registry: TypeRegistry) {
    registry.extend(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY, {
      attributes: [
        { name: "decimals", valueType: ATTR_SUBTYPE_INT, required: false, description: "Test-only — #265 compose-load probe attr." },
      ],
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
  "extend-spec-subtype": extendSpecSubtypeProvider,
};

interface ExpectAttrs {
  type: string;
  subType: string;
  contains: string[];
}

interface Manifest {
  description?: string;
  providers: string[];
  // Flat-corpus (error-code) shape — unchanged.
  expectedError?: string;
  sealThenRegister?: string;
  // #265 compose-load shape — see README.md "The `compose-load/` subdir".
  composeWithCore?: boolean;
  expectAttrs?: ExpectAttrs;
  metadata?: unknown;
  expectErrors?: string[];
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
    // Flat-corpus manifests always carry expectedError (the old shape); guard +
    // narrow rather than a non-null assertion so a malformed fixture fails loud.
    const expectedError = manifest.expectedError;
    if (expectedError === undefined) {
      throw new Error(`flat-corpus manifest "${file}" is missing required "expectedError"`);
    }

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
      expect(errorCode(caught)).toBe(expectedError);
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
    expect(errorCode(caught)).toBe(expectedError);
  });
}

// ---------------------------------------------------------------------------
// #265 compose-load corpus — see README.md "The `compose-load/` subdir".
// Own directory, own loop: a manifest here never carries `expectedError` /
// `sealThenRegister` (the flat-corpus shape); it carries `composeWithCore` /
// `expectAttrs` / `metadata` / `expectErrors` instead.
// ---------------------------------------------------------------------------

const composeLoadManifestFiles = readdirSync(COMPOSE_LOAD_CORPUS)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("provider-composition compose-load corpus is non-empty (guards against a mis-pathed COMPOSE_LOAD_CORPUS)", () => {
  expect(composeLoadManifestFiles.length).toBeGreaterThan(0);
});

for (const file of composeLoadManifestFiles) {
  test(`provider-composition (compose-load): ${file}`, async () => {
    const manifest: Manifest = await Bun.file(join(COMPOSE_LOAD_CORPUS, file)).json();
    const providers = manifest.providers.map(resolve);

    const registry = manifest.composeWithCore
      ? composeRegistry([...coreProviders, ...providers])
      : composeRegistry(providers);

    if (manifest.expectAttrs !== undefined) {
      const { type, subType, contains } = manifest.expectAttrs;
      const declaredNames = registry.attrsOf(type, subType).map((a) => a.name);
      for (const name of contains) {
        expect(declaredNames).toContain(name);
      }
    }

    if (manifest.metadata !== undefined) {
      const doc = JSON.stringify(manifest.metadata);
      const result = await MetaDataLoader.fromString(doc, "json", { registry, strict: true });
      const actualCodes = result.errors.map(errorCode).sort();
      const expectedCodes = [...(manifest.expectErrors ?? [])].sort();
      expect(actualCodes).toEqual(expectedCodes);
    }
  });
}
