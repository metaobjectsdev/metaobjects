// FR-023 Phase 1a, Task 14 — `meta deps sync` (`path` transport) and
// `meta deps list`.
//
// The scaffold: a PUBLISHER directory (`acme-common/metaobjects/`) holding a
// hand-written manifest (`metaobjects.pkg.json`) beside the pinned
// `dependency-conformance` artifact, and a CONSUMER directory
// (`consumer/.metaobjects/config.json`) declaring a `path` dependency on it —
// laid out as SIBLINGS under one temp root, exactly as the Global Constraints
// `CONFIG_REF` (`"path": "../acme-common/metaobjects"`) expects.
//
// `meta deps sync` is the thing that turns that declaration into a committed
// snapshot (`.metaobjects/deps/acme-common/acme-common.metaobjects.json`) and
// a sha256-pinned lock (`.metaobjects/deps.lock.json`); `meta deps list`
// reports what the lock holds.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { INTEGRITY_PREFIX, sha256Integrity } from "@metaobjectsdev/sdk";
import { run } from "../src/index.js";

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";
const MANIFEST_BASENAME = "metaobjects.pkg.json";
const NODES = ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"];

// The corpus this repo already pins (fixtures/dependency-conformance/README.md,
// and the Global Constraints "Hash format" block) — read as raw bytes so the
// snapshot-equality assertions below compare byte-for-byte, never a re-typed
// (and possibly re-formatted) copy.
const CORPUS_ARTIFACTS = resolve(
  import.meta.dirname,
  "../../../../../fixtures/dependency-conformance/artifacts",
);
const V1_BYTES = readFileSync(join(CORPUS_ARTIFACTS, "acme-common-v1.json"));
const WIDENED_BYTES = readFileSync(join(CORPUS_ARTIFACTS, "acme-common-v1-widened.json"));
const V1_HASH = sha256Integrity(V1_BYTES);
const WIDENED_HASH = sha256Integrity(WIDENED_BYTES);

/** First 8 hex chars after the `INTEGRITY_PREFIX` — `meta deps sync`'s report
 *  format. Mirrors (deliberately not imports — this is a CLI test, not a
 *  caller of `dependency-sync.ts`'s internals) the shared `hash8` helper
 *  exported from `src/lib/dependency-sync.ts`. */
function hash8(integrity: string): string {
  return integrity.slice(INTEGRITY_PREFIX.length, INTEGRITY_PREFIX.length + 8);
}

/** The consumer's own model: one entity it owns. Mirrors the shape
 *  `gen-imported-nodes.test.ts` / `verify-requirements-imported.test.ts` use —
 *  present so the post-sync full-collection load (brief step 8) has a real
 *  combined model (own + dependency) to prove loadable, not an empty tree. */
const APP = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** Global Constraints `CONFIG_REF`, verbatim. */
const CONFIG_REF = JSON.stringify({
  schema_version: 1,
  sources: [],
  dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
});

function manifestJson(opts: { version: string; integrity: string; nodes: string[] }): string {
  return JSON.stringify(
    {
      schema_version: 1,
      name: DEP_NAME,
      version: opts.version,
      metamodelVersion: METAMODEL_VERSION,
      artifact: ARTIFACT_BASENAME,
      integrity: opts.integrity,
      packages: ["acme::common"],
      nodes: opts.nodes,
    },
    null,
    2,
  );
}

/** Global Constraints `LOCK_V1`, using the live `METAMODEL_VERSION` constant
 *  rather than a hardcoded "1.0" (same rationale as the sibling FR-023
 *  fixtures already in this package: `gen-imported-nodes.test.ts` etc.). */
const LOCK_V1 = {
  schema_version: 1,
  dependencies: {
    [DEP_NAME]: {
      version: "1.0.0",
      metamodelVersion: METAMODEL_VERSION,
      resolvedFrom: { path: "../acme-common/metaobjects" },
      artifact: ARTIFACT_BASENAME,
      integrity: V1_HASH,
      packages: ["acme::common"],
      nodes: NODES,
    },
  },
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A publisher + consumer pair, laid out as siblings under one temp root. */
function setupProject(): { root: string; consumerRoot: string; publisherDir: string } {
  const root = mkdtempSync(join(tmpdir(), "deps-sync-"));
  dirs.push(root);

  const consumerRoot = join(root, "consumer");
  mkdirSync(join(consumerRoot, "metaobjects"), { recursive: true });
  writeFileSync(join(consumerRoot, "metaobjects", "meta.app.json"), APP, "utf8");
  mkdirSync(join(consumerRoot, ".metaobjects"), { recursive: true });
  writeFileSync(join(consumerRoot, ".metaobjects", "config.json"), CONFIG_REF, "utf8");

  const publisherDir = join(root, "acme-common", "metaobjects");
  mkdirSync(publisherDir, { recursive: true });
  writeFileSync(join(publisherDir, ARTIFACT_BASENAME), V1_BYTES);
  writeFileSync(
    join(publisherDir, MANIFEST_BASENAME),
    manifestJson({ version: "1.0.0", integrity: V1_HASH, nodes: NODES }),
    "utf8",
  );

  return { root, consumerRoot, publisherDir };
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta deps sync — path transport (FR-023 Phase 1a Task 14)", () => {
  test("(a) sync creates a byte-equal snapshot and a lock equal to LOCK_V1", async () => {
    const { consumerRoot } = setupProject();

    const exit = await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);

    const snapPath = join(consumerRoot, ".metaobjects", "deps", DEP_NAME, ARTIFACT_BASENAME);
    expect(readFileSync(snapPath)).toEqual(V1_BYTES);

    const lock = JSON.parse(
      readFileSync(join(consumerRoot, ".metaobjects", "deps.lock.json"), "utf8"),
    );
    expect(lock).toEqual(LOCK_V1);
  });

  test("(b) a second sync prints 'unchanged' and leaves the lock bytes identical", async () => {
    const { consumerRoot } = setupProject();
    await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    const lockPath = join(consumerRoot, ".metaobjects", "deps.lock.json");
    const before = readFileSync(lockPath, "utf8");

    out = [];
    err = [];
    const exit = await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
    expect([...out, ...err].join("\n")).toContain("unchanged");

    expect(readFileSync(lockPath, "utf8")).toBe(before);
  });

  test("(c) --dry-run writes nothing", async () => {
    const { consumerRoot } = setupProject();

    const exit = await run(["deps", "sync", "--dry-run", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
    expect(existsSync(join(consumerRoot, ".metaobjects", "deps.lock.json"))).toBe(false);
    expect(existsSync(join(consumerRoot, ".metaobjects", "deps", DEP_NAME))).toBe(false);
  });

  test("(d) a widened artifact syncs and reports the hash change", async () => {
    const { consumerRoot, publisherDir } = setupProject();
    await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);

    writeFileSync(join(publisherDir, ARTIFACT_BASENAME), WIDENED_BYTES);
    writeFileSync(
      join(publisherDir, MANIFEST_BASENAME),
      manifestJson({ version: "1.1.0", integrity: WIDENED_HASH, nodes: NODES }),
      "utf8",
    );

    out = [];
    err = [];
    const exit = await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("synced acme-common");
    expect(printed).toContain(`(${hash8(V1_HASH)}→${hash8(WIDENED_HASH)})`);

    const lock = JSON.parse(
      readFileSync(join(consumerRoot, ".metaobjects", "deps.lock.json"), "utf8"),
    );
    expect(lock.dependencies[DEP_NAME].integrity).toBe(WIDENED_HASH);
    expect(
      readFileSync(join(consumerRoot, ".metaobjects", "deps", DEP_NAME, ARTIFACT_BASENAME)),
    ).toEqual(WIDENED_BYTES);
  });

  test("(e) removing the dependency from config prunes the lock entry and the snapshot dir", async () => {
    const { consumerRoot } = setupProject();
    await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(existsSync(join(consumerRoot, ".metaobjects", "deps", DEP_NAME))).toBe(true);

    writeFileSync(
      join(consumerRoot, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, sources: [], dependencies: [] }),
      "utf8",
    );

    const exit = await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);

    const lock = JSON.parse(
      readFileSync(join(consumerRoot, ".metaobjects", "deps.lock.json"), "utf8"),
    );
    expect(lock.dependencies).toEqual({});
    expect(existsSync(join(consumerRoot, ".metaobjects", "deps", DEP_NAME))).toBe(false);
  });

  test('(f) a manifest whose "nodes" omits Customer fails the sync', async () => {
    const { consumerRoot, publisherDir } = setupProject();
    // The ARTIFACT is untouched (still declares Customer) — only the
    // manifest's declared "nodes" is wrong, so this exercises the
    // standalone-load node-set check, not the hash check.
    writeFileSync(
      join(publisherDir, MANIFEST_BASENAME),
      manifestJson({
        version: "1.0.0",
        integrity: V1_HASH,
        nodes: ["acme::common::Address", "acme::common::Audited"],
      }),
      "utf8",
    );

    const exit = await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(1);
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("acme::common::Customer");
    expect(existsSync(join(consumerRoot, ".metaobjects", "deps.lock.json"))).toBe(false);
  });

  test("(g) an npm transport spec refuses — 'not supported by this toolchain yet'", async () => {
    const root = mkdtempSync(join(tmpdir(), "deps-sync-npm-"));
    dirs.push(root);
    mkdirSync(join(root, "metaobjects"), { recursive: true });
    writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");
    mkdirSync(join(root, ".metaobjects"), { recursive: true });
    writeFileSync(
      join(root, ".metaobjects", "config.json"),
      JSON.stringify({
        schema_version: 1,
        sources: [],
        dependencies: [{ name: "x", npm: "@acme/model" }],
      }),
      "utf8",
    );

    const exit = await run(["deps", "sync", "--format", "text", "--cwd", root]);
    expect(exit).toBe(1);
    expect([...out, ...err].join("\n")).toContain("not supported by this toolchain yet");
  });

  test("(h) list after a sync prints one summary line per lock entry", async () => {
    const { consumerRoot } = setupProject();
    await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);

    out = [];
    err = [];
    const exit = await run(["deps", "list", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
    expect([...out, ...err].join("\n")).toContain(
      `acme-common 1.0.0 ${hash8(V1_HASH)} 3 node(s) acme::common`,
    );
  });
});

// Fix round 1, FIX 4 — `meta deps sync <name>` (the positional name filter)
// had zero automated coverage: nothing proved that syncing ONE declared
// dependency by name (a) leaves every OTHER dependency's lock entry
// byte-identical, untouched, and (b) still seeds node-ownership from those
// untouched entries, so a newly-resolved target can still collide against a
// dependency the run never targeted. Task 15's `check` is specified to
// resolve "exactly as sync steps 1-2 do", so this carry-forward/collision
// seeding is machinery a later task builds on.
describe("meta deps sync <name> — the name filter (FR-023 Phase 1a Task 14, fix round 1)", () => {
  const SECOND_NAME = "acme-extra";
  const SECOND_ARTIFACT_BASENAME = "acme-extra.metaobjects.json";
  const SECOND_PACKAGES = ["acme::extra"];
  const SECOND_NODES = ["acme::extra::Widget"];

  // A second, independent publisher — one object.value with a single field,
  // small enough to hand-write rather than borrow from the shared corpus
  // (which has no second, unrelated dependency fixture; this test needs two).
  const SECOND_ARTIFACT_CONTENT =
    JSON.stringify(
      {
        "metadata.root": {
          children: [
            {
              "object.value": {
                name: "Widget",
                package: "acme::extra",
                children: [{ "field.string": { name: "label" } }],
              },
            },
          ],
        },
      },
      null,
      2,
    ) + "\n";
  const SECOND_HASH = sha256Integrity(SECOND_ARTIFACT_CONTENT);

  /** A manifest with fully overridable `name`/`artifact`/`packages`/`nodes` —
   *  unlike the top-level `manifestJson`, which is hardcoded to `acme-common`
   *  in package `acme::common`. Scoped to this describe block only: the
   *  colliding-manifest scenario below needs `acme-common`'s OWN manifest to
   *  (incorrectly) declare `acme::extra`'s package/node, which the shared
   *  helper cannot express. */
  function genericManifest(opts: {
    name: string;
    artifact: string;
    version: string;
    integrity: string;
    nodes: string[];
    packages: string[];
  }): string {
    return JSON.stringify(
      {
        schema_version: 1,
        name: opts.name,
        version: opts.version,
        metamodelVersion: METAMODEL_VERSION,
        artifact: opts.artifact,
        integrity: opts.integrity,
        packages: opts.packages,
        nodes: opts.nodes,
      },
      null,
      2,
    );
  }

  function setupTwoDependencyProject(): {
    consumerRoot: string;
    commonPublisherDir: string;
    extraPublisherDir: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "deps-sync-filter-"));
    dirs.push(root);

    const consumerRoot = join(root, "consumer");
    mkdirSync(join(consumerRoot, "metaobjects"), { recursive: true });
    writeFileSync(join(consumerRoot, "metaobjects", "meta.app.json"), APP, "utf8");
    mkdirSync(join(consumerRoot, ".metaobjects"), { recursive: true });
    writeFileSync(
      join(consumerRoot, ".metaobjects", "config.json"),
      JSON.stringify({
        schema_version: 1,
        sources: [],
        dependencies: [
          { name: DEP_NAME, path: "../acme-common/metaobjects" },
          { name: SECOND_NAME, path: "../acme-extra/metaobjects" },
        ],
      }),
      "utf8",
    );

    const commonPublisherDir = join(root, "acme-common", "metaobjects");
    mkdirSync(commonPublisherDir, { recursive: true });
    writeFileSync(join(commonPublisherDir, ARTIFACT_BASENAME), V1_BYTES);
    writeFileSync(
      join(commonPublisherDir, MANIFEST_BASENAME),
      manifestJson({ version: "1.0.0", integrity: V1_HASH, nodes: NODES }),
      "utf8",
    );

    const extraPublisherDir = join(root, "acme-extra", "metaobjects");
    mkdirSync(extraPublisherDir, { recursive: true });
    writeFileSync(join(extraPublisherDir, SECOND_ARTIFACT_BASENAME), SECOND_ARTIFACT_CONTENT, "utf8");
    writeFileSync(
      join(extraPublisherDir, MANIFEST_BASENAME),
      genericManifest({
        name: SECOND_NAME,
        artifact: SECOND_ARTIFACT_BASENAME,
        version: "1.0.0",
        integrity: SECOND_HASH,
        nodes: SECOND_NODES,
        packages: SECOND_PACKAGES,
      }),
      "utf8",
    );

    return { consumerRoot, commonPublisherDir, extraPublisherDir };
  }

  test("syncing one dependency by name leaves the other's lock entry byte-identical, and still guards against collision", async () => {
    const { consumerRoot, commonPublisherDir } = setupTwoDependencyProject();

    // Baseline: sync everything declared.
    expect(await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot])).toBe(0);

    const lockPath = join(consumerRoot, ".metaobjects", "deps.lock.json");
    const afterInitial = JSON.parse(readFileSync(lockPath, "utf8"));
    const extraEntryBefore = afterInitial.dependencies[SECOND_NAME];
    expect(extraEntryBefore).toBeDefined();

    // Widen acme-common ONLY — acme-extra's publisher is never touched again
    // in this test.
    writeFileSync(join(commonPublisherDir, ARTIFACT_BASENAME), WIDENED_BYTES);
    writeFileSync(
      join(commonPublisherDir, MANIFEST_BASENAME),
      manifestJson({ version: "1.1.0", integrity: WIDENED_HASH, nodes: NODES }),
      "utf8",
    );

    out = [];
    err = [];
    const filteredExit = await run([
      "deps",
      "sync",
      DEP_NAME,
      "--format",
      "text",
      "--cwd",
      consumerRoot,
    ]);
    expect(filteredExit).toBe(0);
    expect([...out, ...err].join("\n")).toContain("synced acme-common");

    const afterFiltered = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(afterFiltered.dependencies[DEP_NAME].integrity).toBe(WIDENED_HASH);
    // The untargeted dependency's entry is BYTE-IDENTICAL to what it was
    // before this run — the carry-forward path, not a silent re-validation
    // or re-copy of something nobody asked to sync.
    expect(afterFiltered.dependencies[SECOND_NAME]).toEqual(extraEntryBefore);

    // Now replace acme-common's publisher with an artifact that (incorrectly)
    // exports the EXACT fully-qualified node acme-extra already owns
    // ("acme::extra::Widget"). A name-filtered `sync acme-common` must still
    // catch this against acme-extra's UNTOUCHED lock entry — proving
    // `planSync` seeds node ownership from carried-forward entries, not only
    // from the targets this run resolves.
    const collidingHash = sha256Integrity(SECOND_ARTIFACT_CONTENT);
    writeFileSync(join(commonPublisherDir, ARTIFACT_BASENAME), SECOND_ARTIFACT_CONTENT, "utf8");
    writeFileSync(
      join(commonPublisherDir, MANIFEST_BASENAME),
      genericManifest({
        name: DEP_NAME,
        artifact: ARTIFACT_BASENAME,
        version: "1.2.0",
        integrity: collidingHash,
        nodes: SECOND_NODES,
        packages: SECOND_PACKAGES,
      }),
      "utf8",
    );

    out = [];
    err = [];
    const collisionExit = await run([
      "deps",
      "sync",
      DEP_NAME,
      "--format",
      "text",
      "--cwd",
      consumerRoot,
    ]);
    expect(collisionExit).toBe(1);
    const collisionPrinted = [...out, ...err].join("\n");
    expect(collisionPrinted).toContain(SECOND_NAME);
    expect(collisionPrinted).toContain(DEP_NAME);
    expect(collisionPrinted).toContain("acme::extra::Widget");

    // A collision is caught during PLANNING (read-only) — the lock must be
    // completely untouched by the failed attempt.
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(afterFiltered);
  });

  // Fix round 2 — the test above exercises real code but does not
  // DISCRIMINATE: a mutant that deletes filtering (`targets = [...specs]`
  // unconditionally, ignoring `filterNames`) passes every assertion in it,
  // because the untargeted dependency's publisher is untouched either way, so
  // "carried forward" and "re-resolved fresh" produce byte-identical results.
  //
  // This test makes the untargeted dependency IMPOSSIBLE to process
  // successfully (its publisher directory is deleted outright), then proves a
  // name-filtered sync succeeds anyway. Under correct filtering, the deleted
  // dependency is never touched, so its absence is irrelevant. Under the
  // mutant above, BOTH dependencies are processed every run, so
  // `resolveDependencyDir` throws `ERR_DEPENDENCY_UNRESOLVED` for the deleted
  // one and the whole sync fails — the one asymmetry the test above lacked.
  test("a filtered sync never re-resolves the untargeted dependency, even when its publisher is gone", async () => {
    const { consumerRoot, extraPublisherDir } = setupTwoDependencyProject();

    // Baseline: sync everything declared.
    expect(await run(["deps", "sync", "--format", "text", "--cwd", consumerRoot])).toBe(0);

    const lockPath = join(consumerRoot, ".metaobjects", "deps.lock.json");
    const baseline = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(baseline.dependencies[SECOND_NAME]).toBeDefined();
    expect(baseline.dependencies[DEP_NAME]).toBeDefined();

    // acme-extra can no longer be resolved by ANY path — its whole publisher
    // directory is gone. It is still DECLARED in the consumer's config, so a
    // correctly-filtered `sync acme-common` must carry its lock entry forward
    // untouched rather than attempt to re-resolve it.
    rmSync(extraPublisherDir, { recursive: true, force: true });

    out = [];
    err = [];
    const exit = await run([
      "deps",
      "sync",
      DEP_NAME, // acme-extra is never named
      "--format",
      "text",
      "--cwd",
      consumerRoot,
    ]);

    expect(exit).toBe(0);

    const after = JSON.parse(readFileSync(lockPath, "utf8"));
    // acme-common's own manifest never changed since the baseline sync — this
    // filtered run reports it "unchanged." The load-bearing assertion is
    // below: acme-extra's entry survives BYTE-IDENTICAL despite its publisher
    // directory not existing on disk at all.
    expect(after.dependencies[DEP_NAME]).toEqual(baseline.dependencies[DEP_NAME]);
    expect(after.dependencies[SECOND_NAME]).toEqual(baseline.dependencies[SECOND_NAME]);
  });
});
