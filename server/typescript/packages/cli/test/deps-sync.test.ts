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
import { sha256Integrity } from "@metaobjectsdev/sdk";
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

/** First 8 hex chars after the "sha256-" prefix — `meta deps sync`'s report format. */
function hash8(integrity: string): string {
  return integrity.slice("sha256-".length, "sha256-".length + 8);
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
