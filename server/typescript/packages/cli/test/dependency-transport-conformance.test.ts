// Runs fixtures/dependency-conformance/transport-cases.json (FR-023 DESIGN §2.1)
// against `meta deps sync`'s transports: an `npm` package installed under a temp
// `node_modules`, a `python` package on a temp import path. No network, no
// package manager — each case lays out what an install would leave on disk.
//
// Node `meta deps sync` is the only writer of snapshots and the lock, so only
// this runner executes the transport arm; every port then loads the snapshot
// (the `cases.json` arm, which carries npm and python cases too).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_METAOBJECTS_DIR, LOCK_FILE, dependencyName, loadConfig } from "@metaobjectsdev/sdk";
import { applySync, planSync } from "../src/lib/dependency-sync.js";
import { METAOBJECTS_PYTHON_ENV, resolveTransport } from "../src/lib/dependency-transports.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly treeFiles?: Record<string, string>;
  readonly config: unknown;
  readonly resolveFrom?: string;
  readonly pythonPath?: readonly string[];
  readonly expectDirs?: Record<string, string>;
  readonly expectLock?: unknown;
  readonly expectError?: string;
}

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance");
const cases: Case[] = JSON.parse(await readFile(join(CORPUS_DIR, "transport-cases.json"), "utf8")).cases;
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(PYTHON, ["--version"]).status === 0;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

async function materialize(c: Case): Promise<{ root: string; configDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mo-dep-transport-")));
  roots.push(root);
  for (const [rel, content] of Object.entries(c.tree)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  for (const [rel, corpusRel] of Object.entries(c.treeFiles ?? {})) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await copyFile(join(CORPUS_DIR, corpusRel), abs);
  }
  const configDir = resolve(root, c.resolveFrom ?? ".");
  await mkdir(join(configDir, DEFAULT_METAOBJECTS_DIR), { recursive: true });
  await writeFile(join(configDir, DEFAULT_METAOBJECTS_DIR, "config.json"), JSON.stringify(c.config, null, 2));
  return { root, configDir };
}

/** The case's import path stands in for an installed site-packages; the host's
 *  own virtualenv and interpreter override are cleared so the result does not
 *  depend on the machine running the corpus. */
function caseEnv(root: string, c: Case): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[METAOBJECTS_PYTHON_ENV];
  delete env.VIRTUAL_ENV;
  env.PYTHONPATH = (c.pythonPath ?? []).map((p) => join(root, p)).join(delimiter);
  return env;
}

describe("dependency conformance — the transport arm", () => {
  test("the corpus carries npm and python transport cases (a silent zero-case run is a failed gate)", () => {
    expect(cases.some((c) => JSON.stringify(c.config).includes('"npm"'))).toBe(true);
    expect(cases.some((c) => JSON.stringify(c.config).includes('"python"'))).toBe(true);
  });

  for (const c of cases) {
    const needsPython = JSON.stringify(c.config).includes('"python"');
    test.skipIf(needsPython && !hasPython)(c.name, async () => {
      if ((c.expectLock === undefined) === (c.expectError === undefined)) {
        throw new Error(`transport case "${c.name}" must carry exactly one of expectLock, expectError`);
      }
      const { root, configDir } = await materialize(c);
      const env = caseEnv(root, c);
      const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));

      if (c.expectDirs !== undefined) {
        const dirs = Object.fromEntries(
          cfg.dependencies.map((s) => [
            dependencyName(s),
            relative(root, resolveTransport(configDir, s, env).dir).split("\\").join("/"),
          ]),
        );
        expect(dirs).toEqual(c.expectDirs);
      }

      if (c.expectError !== undefined) {
        await expect(planSync(configDir, cfg.dependencies, undefined, [], env)).rejects.toMatchObject({
          code: c.expectError,
        });
        return;
      }
      const plan = await planSync(configDir, cfg.dependencies, undefined, [], env);
      await applySync(configDir, plan, { dryRun: false });
      const written = JSON.parse(await readFile(join(configDir, DEFAULT_METAOBJECTS_DIR, LOCK_FILE), "utf8"));
      expect(written).toEqual(c.expectLock);
    });
  }
});
