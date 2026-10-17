#!/usr/bin/env node
// Tests for scripts/prerelease-version.mjs — the decisions that number a pre-release cut.
//
//   node scripts/test-prerelease-version.mjs
//
// P1  "released" comes from public npm and the release tags, not package.json, and a cut never
//     skips an unpublished CHANGELOG section (release prep bumped package.json to 1.1.0 and the
//     next rc went out as 1.2.0-rc.3).
// P2  the iteration counter reads every page of the registry's listing.
// P3  a SIGTERM restores the version files, as exit and SIGINT already did, and stops a step that
//     is still running instead of letting the run publish the remaining registries first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  changelogVersions, collectPages, decideBase, latestReleaseTag, releasedVersion, run,
} from "./prerelease-version.mjs";

let fails = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok:   ${name}`); }
  catch (e) { fails++; console.error(`FAIL: ${name}\n      ${e.message}`); }
};

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] — 2026-10-10\n\n## [1.0.13] — 2026-10-03\n\n## [1.0.12]\n";

await test("changelog sections are read in order, [Unreleased] skipped", () => {
  assert.deepEqual(changelogVersions(CHANGELOG), ["1.1.0", "1.0.13", "1.0.12"]);
});

await test("the release tag is the highest plain tag on the npm major line", () => {
  assert.equal(latestReleaseTag(["v1.0.9", "v1.0.13", "v1.1.0-rc.3", "v7.20.12", "v1.0.10"], 1), "1.0.13");
  assert.equal(latestReleaseTag(["v7.20.12"], 1), null);
});

await test("P1: release prep's package.json bump does not make 1.1.0 'released'", () => {
  // package.json says 1.1.0 (the prep PR); npm and the tags say 1.0.13.
  const released = releasedVersion({ npmLatest: "1.0.13", tags: ["v1.0.13", "v1.1.0-rc.2"], major: 1 });
  assert.equal(released, "1.0.13");
  assert.deepEqual(decideBase({ released, changelog: changelogVersions(CHANGELOG), explicit: null }),
    { base: "1.1.0", source: "CHANGELOG.md" });
});

await test("released is the newer of npm and the tags (either may lag)", () => {
  assert.equal(releasedVersion({ npmLatest: "1.0.12", tags: ["v1.0.13"], major: 1 }), "1.0.13");
  assert.equal(releasedVersion({ npmLatest: "1.0.13", tags: [], major: 1 }), "1.0.13");
  assert.equal(releasedVersion({ npmLatest: null, tags: [], major: 1 }), null);
});

await test("once 1.1.0 is released, the next minor is guessed", () => {
  assert.deepEqual(decideBase({ released: "1.1.0", changelog: ["1.1.0", "1.0.13"], explicit: null }),
    { base: "1.2.0", source: "guessed from released 1.1.0" });
});

await test("a patch section ahead of the release is the base, not the next minor", () => {
  assert.equal(decideBase({ released: "1.0.13", changelog: ["1.0.14", "1.0.13"], explicit: null }).base, "1.0.14");
});

await test("--base may not skip an unpublished CHANGELOG section", () => {
  assert.throws(() => decideBase({ released: "1.0.13", changelog: ["1.1.0", "1.0.13"], explicit: "1.2.0" }),
    /would skip the unpublished CHANGELOG section \[1\.1\.0\]/);
  assert.equal(decideBase({ released: "1.0.13", changelog: ["1.1.0"], explicit: "1.1.0" }).base, "1.1.0");
});

await test("--base may not name a released version", () => {
  assert.throws(() => decideBase({ released: "1.1.0", changelog: ["1.1.0"], explicit: "1.1.0" }), /not newer/);
});

await test("with nothing to read, only an explicit --base proceeds", () => {
  assert.throws(() => decideBase({ released: null, changelog: ["1.1.0"], explicit: null }), /Pass --base/);
  assert.equal(decideBase({ released: null, changelog: ["1.1.0"], explicit: "1.1.0" }).base, "1.1.0");
});

await test("P2: every page is read, and the walk stops at the first short page", async () => {
  const items = Array.from({ length: 352 }, (_, i) => i);
  const asked = [];
  const all = await collectPages((page, limit) => {
    asked.push(page);
    return items.slice((page - 1) * limit, page * limit);
  }, 50);
  assert.equal(all.length, 352);
  assert.deepEqual(asked, [1, 2, 3, 4, 5, 6, 7, 8]);
  // An exact multiple ends on the empty page that follows it.
  const exact = await collectPages((page, limit) => items.slice(0, 100).slice((page - 1) * limit, page * limit), 50);
  assert.equal(exact.length, 100);
});

await test("P3: SIGTERM runs the restore before the process ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prerelease-sigterm-"));
  try {
    const marker = join(dir, "restored");
    const child = join(dir, "child.mjs");
    const mod = pathToFileURL(join(import.meta.dirname, "prerelease-version.mjs")).href;
    writeFileSync(child, `
      import { writeFileSync } from "node:fs";
      import { installRestoreHandlers } from ${JSON.stringify(mod)};
      installRestoreHandlers(() => writeFileSync(${JSON.stringify(marker)}, "yes"));
      console.log("ready");
      setInterval(() => {}, 1000);
    `);
    const proc = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => proc.stdout.once("data", resolve));
    const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
    proc.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143);
    assert.ok(existsSync(marker), "restore did not run on SIGTERM");
    assert.equal(readFileSync(marker, "utf8"), "yes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("P3: SIGTERM during a running step stops the step and the run, then restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prerelease-sigterm-step-"));
  try {
    const at = (name) => join(dir, name);
    const child = at("child.mjs");
    const mod = pathToFileURL(join(import.meta.dirname, "prerelease-version.mjs")).href;
    // The step backgrounds a subshell, which a kill of the shell alone would leave running.
    const step = `echo up > '${at("started")}'; (sleep 1; echo leaked > '${at("leaked")}') & wait`;
    writeFileSync(child, `
      import { writeFileSync } from "node:fs";
      import { installRestoreHandlers, run } from ${JSON.stringify(mod)};
      installRestoreHandlers(() => writeFileSync(${JSON.stringify(at("restored"))}, "yes"));
      await run(${JSON.stringify(step)});
      writeFileSync(${JSON.stringify(at("continued"))}, "yes");
    `);
    const proc = spawn(process.execPath, [child], { stdio: "inherit" });
    const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 250 && !existsSync(at("started")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(at("started")), "the step never started");
    proc.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143);
    assert.ok(existsSync(at("restored")), "restore did not run on SIGTERM");
    assert.ok(!existsSync(at("continued")), "the run went on to its next step after SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!existsSync(at("leaked")), "the step's own children outlived the SIGTERM");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a step resolves to its stdout and rejects on a non-zero exit", async () => {
  assert.equal(await run("printf 'a\\nb'"), "a\nb");
  await assert.rejects(run("echo boom >&2; exit 3"), /exit 3.*\n.*boom/s);
});

if (fails) { console.error(`${fails} failure(s)`); process.exit(1); }
console.log("all prerelease-version tests passed");
