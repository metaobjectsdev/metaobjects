// FR-023 Phase 1a, Task 15 — `meta deps check` and `meta verify --deps`.
//
// Same publisher/consumer scaffold as `deps-sync.test.ts` (Task 14): a PUBLISHER
// directory (`acme-common/metaobjects/`) holding a manifest beside the pinned
// `dependency-conformance` artifact, and a CONSUMER (`consumer/.metaobjects/config.json`)
// declaring a `path` dependency on it. Every test here starts from an
// ALREADY-SYNCED consumer (a real `deps sync` run, so the lock is real) and then
// perturbs the PUBLISHER only — proving `check`/`verify --deps` compare the
// installed artifact against the lock without ever re-running `sync` itself.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// hash assertions below are computed off the real corpus, never a re-typed copy.
const CORPUS_ARTIFACTS = resolve(
  import.meta.dirname,
  "../../../../../fixtures/dependency-conformance/artifacts",
);
const V1_BYTES = readFileSync(join(CORPUS_ARTIFACTS, "acme-common-v1.json"));
const WIDENED_BYTES = readFileSync(join(CORPUS_ARTIFACTS, "acme-common-v1-widened.json"));
const V1_HASH = sha256Integrity(V1_BYTES);
const WIDENED_HASH = sha256Integrity(WIDENED_BYTES);

/** First 8 hex chars after the `INTEGRITY_PREFIX` — mirrors the shared `hash8`
 *  helper exported from `src/lib/dependency-sync.ts` (deliberately not
 *  imported — this is a CLI test, not a caller of that module's internals). */
function hash8(integrity: string): string {
  return integrity.slice(INTEGRITY_PREFIX.length, INTEGRITY_PREFIX.length + 8);
}

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

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A publisher + consumer pair, laid out as siblings under one temp root —
 *  identical layout to `deps-sync.test.ts`'s `setupProject()`. */
function setupProject(): { root: string; consumerRoot: string; publisherDir: string } {
  const root = mkdtempSync(join(tmpdir(), "deps-check-"));
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

/** Runs `argv`, capturing console.log/console.error separately, mirroring
 *  `advisory-structured-output.test.ts`'s `capture()` — needed here (rather
 *  than `deps-sync.test.ts`'s inline out/err arrays) because the `verify
 *  --deps --format json` case needs `out` isolated from stderr narration to
 *  `JSON.parse` it. */
async function capture(argv: string[]): Promise<{ exit: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  let exit: number;
  try {
    exit = await run(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { exit, out: outLines.join("\n"), err: errLines.join("\n") };
}

interface VerifyGateRow {
  gate: string;
  ran: boolean;
  ok: boolean;
}

describe("meta deps check — path transport (FR-023 Phase 1a Task 15)", () => {
  test("(a) after sync, check exits 0 and reports current", async () => {
    const { consumerRoot } = setupProject();
    expect((await capture(["deps", "sync", "--format", "text", "--cwd", consumerRoot])).exit).toBe(0);

    const { exit, out, err } = await capture(["deps", "check", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
    expect(`${out}\n${err}`).toContain(`${DEP_NAME}: current — 1.0.0 (${hash8(V1_HASH)})`);
  });

  test("(b) a widened publisher: check exits 1 with the pinned drift line, and verify --deps exits 1 with a deps row", async () => {
    const { consumerRoot, publisherDir } = setupProject();
    await capture(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);

    writeFileSync(join(publisherDir, ARTIFACT_BASENAME), WIDENED_BYTES);
    writeFileSync(
      join(publisherDir, MANIFEST_BASENAME),
      manifestJson({ version: "1.1.0", integrity: WIDENED_HASH, nodes: NODES }),
      "utf8",
    );

    const checkResult = await capture(["deps", "check", "--format", "text", "--cwd", consumerRoot]);
    expect(checkResult.exit).toBe(1);
    expect(`${checkResult.out}\n${checkResult.err}`).toContain(
      `${DEP_NAME}: drifted — lock 1.0.0 (${hash8(V1_HASH)}), installed 1.1.0 (${hash8(WIDENED_HASH)}); ` +
        "run meta deps sync and review the artifact diff",
    );
    // Pinned exactly, per the task brief — the literal example, not just the
    // interpolation of the same values.
    expect(`${checkResult.out}\n${checkResult.err}`).toContain(
      "acme-common: drifted — lock 1.0.0 (10fbf886), installed 1.1.0 (fa00b9f3); " +
        "run meta deps sync and review the artifact diff",
    );

    const verifyResult = await capture(["verify", "--deps", "--format", "json", "--cwd", consumerRoot]);
    expect(verifyResult.exit).toBe(1);
    const payload = JSON.parse(verifyResult.out.trim()) as { verify: VerifyGateRow[] };
    const depsRow = payload.verify.find((g) => g.gate === "deps");
    expect(depsRow).toEqual({ gate: "deps", ran: true, ok: false });
  });

  test("(c) the publisher directory is gone: check reports unresolved and exits 1", async () => {
    const { consumerRoot, publisherDir } = setupProject();
    await capture(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    rmSync(publisherDir, { recursive: true, force: true });

    const { exit, out, err } = await capture(["deps", "check", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(1);
    const printed = `${out}\n${err}`;
    expect(printed).toContain(`${DEP_NAME}: unresolved`);
    expect(printed).toContain("no directory exists there");
  });

  test("(d) a bare 'meta verify' (no --deps) exits 0 regardless of dependency drift", async () => {
    const { consumerRoot, publisherDir } = setupProject();
    await capture(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);
    // The publisher is now unreachable — 'deps check'/'verify --deps' would
    // both fail against it. A bare 'verify' must never notice.
    rmSync(publisherDir, { recursive: true, force: true });

    const { exit } = await capture(["verify", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(0);
  });

  // Mutation-catching (per the task's own note): an implementation that just
  // compares the LOCK's declared `integrity` string to the INSTALLED
  // manifest's declared `integrity` string — without ever re-hashing the
  // artifact bytes actually on disk — would read this as "current", because
  // neither manifest's OWN `integrity` field changed. The correct
  // implementation re-hashes (via `readManifestDir`, which itself refuses a
  // manifest whose declared integrity no longer matches its artifact) and so
  // must report this as `unresolved`, never `current`.
  test("(e) the installed ARTIFACT bytes changed without regenerating its manifest: never reported current", async () => {
    const { consumerRoot, publisherDir } = setupProject();
    await capture(["deps", "sync", "--format", "text", "--cwd", consumerRoot]);

    // Swap the artifact bytes only. The manifest.pkg.json beside it (untouched)
    // still declares the OLD v1 integrity — a publisher who forgot to
    // regenerate it after editing the artifact by hand.
    writeFileSync(join(publisherDir, ARTIFACT_BASENAME), WIDENED_BYTES);

    const { exit, out, err } = await capture(["deps", "check", "--format", "text", "--cwd", consumerRoot]);
    const printed = `${out}\n${err}`;
    expect(printed).not.toContain(`${DEP_NAME}: current`);
    expect(printed).toContain(`${DEP_NAME}: unresolved`);
    expect(exit).toBe(1);
  });

  // A declared dependency that resolves fine but was never synced (no lock
  // entry at all) has nothing to compare against — "a check that cannot
  // check must not pass" applies here too, not only to a resolution failure.
  test("(g) a declared dependency with no lock entry yet is unresolved, not current", async () => {
    const { consumerRoot } = setupProject();
    // Deliberately no 'deps sync' — the lock file does not exist at all.

    const { exit, out, err } = await capture(["deps", "check", "--format", "text", "--cwd", consumerRoot]);
    expect(exit).toBe(1);
    const printed = `${out}\n${err}`;
    expect(printed).toContain(`${DEP_NAME}: unresolved`);
    expect(printed).not.toContain(`${DEP_NAME}: current`);
  });

  test("(f) no dependencies declared: check exits 0 and does nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "deps-check-none-"));
    dirs.push(root);
    mkdirSync(join(root, "metaobjects"), { recursive: true });
    writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");
    mkdirSync(join(root, ".metaobjects"), { recursive: true });
    writeFileSync(
      join(root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, sources: [], dependencies: [] }),
      "utf8",
    );

    const { exit, out, err } = await capture(["deps", "check", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);
    expect(`${out}\n${err}`).toContain("nothing to check");
  });
});
