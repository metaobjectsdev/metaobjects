#!/usr/bin/env node
// The install-size budget: what `npm install @metaobjectsdev/cli` puts on an adopter's disk,
// measured by installing it, and held to a number that only moves down.
//
// WHY A REAL INSTALL. `scripts/check-peer-ranges.ts` reads manifests, which catches a package
// that REQUIRES something unused. It cannot see what a dependency of a dependency drags in
// (libSQL pulls its own HTTP client and a polyfill for web streams; a native binary comes once per
// libc), and it cannot see a package that doubled in size. This installs the packed CLI the way
// an adopter's package manager does and counts the bytes.
//
//   node scripts/check-install-size.mjs            # check against the budget (the full CI lane)
//   node scripts/check-install-size.mjs --update   # lower the budget to what was measured
//
// THE RULES
//   1. The install must not exceed `budgetBytes`.
//   2. It must not sit more than `slackBytes` UNDER it. A saving that is not written down is a
//      saving the next change can spend, so a smaller install fails until the budget is lowered
//      with --update. That is the ratchet: the budget has no way to rise.
//   3. `budgetBytes` may not be higher than it is on `main`. Raising it to make a change pass
//      is the one edit this file exists to refuse; raise it only with a ruling that says why.
//   4. None of the packages in FORBIDDEN is in the tree (a fresh-install test: the install-time
//      guard in check-peer-ranges.ts reads manifests, this reads the result).
//
// The budget is for the platform it names (`platform`): native binaries differ by platform and
// by libc, so on another platform the check reports the number and passes. It needs the registry
// for third-party packages, which is why it runs in the full CI lane and not in `--only gates`.
// The packages under test are this checkout's, packed with `bun pm pack` (which writes `workspace:`
// ranges as versions), so nothing here depends on a release having been published.
//
// Build first (`bun run --filter '*' build`): a package is packed from its built `dist/`.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateWorkspacePackages } from "./publish-set.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_FILE = "scripts/install-size-budget.json";
const BUDGET_PATH = join(ROOT, BUDGET_FILE);
const ENTRY = "@metaobjectsdev/cli";
const SCOPE = "@metaobjectsdev/";
const MB = 1024 * 1024;

/** Packages that must not be installed by installing the CLI, and why. */
const FORBIDDEN = {
  "drizzle-orm": "only generated code imports it; codegen-ts lists it as an optional peer",
  "@biomejs/biome": "generation runs no formatter; the CLI compares owned copies through the WebAssembly build",
  "dprint-node": "seven native binaries; codegen-ts runs dprint as WebAssembly",
  "ts-poet": "requires dprint-node on load; codegen-ts vendors the printer",
};

const update = process.argv.includes("--update");

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** The workspace packages the CLI installs: it, and every `@metaobjectsdev/*` it requires, transitively. */
function closureOf(entry, byName) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = byName.get(name);
    if (pkg === undefined) continue;
    const required = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}).filter((d) => pkg.peerDependenciesMeta?.[d]?.optional !== true),
    ];
    for (const dep of required) if (dep.startsWith(SCOPE)) queue.push(dep);
  }
  return [...seen].sort();
}

/** Bytes of every regular file under `dir`, what `du -sb` counts. */
function bytesUnder(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += bytesUnder(path);
    else if (entry.isFile()) total += lstatSync(path).size;
  }
  return total;
}

/** The top-level package directories of `node_modules`, scopes opened, largest first. */
function breakdown(modules) {
  const rows = [];
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const inner of readdirSync(path, { withFileTypes: true })) {
        if (inner.isDirectory()) rows.push({ name: `${entry.name}/${inner.name}`, bytes: bytesUnder(join(path, inner.name)) });
      }
    } else {
      rows.push({ name: entry.name, bytes: bytesUnder(path) });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

function installedNames(modules) {
  const names = [];
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) {
      for (const inner of readdirSync(join(modules, entry.name), { withFileTypes: true })) names.push(`${entry.name}/${inner.name}`);
    } else names.push(entry.name);
  }
  return names;
}

function mainBudget() {
  try {
    const text = execFileSync("git", ["show", `main:${BUDGET_FILE}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(text).budgetBytes;
  } catch {
    return undefined; // no `main` here, or the file is new on this branch
  }
}

function measure() {
  const packages = enumerateWorkspacePackages(ROOT).map(({ dir, pkg }) => ({ dir, pkg }));
  const byName = new Map(packages.map(({ pkg }) => [pkg.name, pkg]));
  const wanted = closureOf(ENTRY, byName);
  const dirs = new Map(packages.map(({ dir, pkg }) => [pkg.name, dir]));
  // Throwaway data goes to RAM when the machine has set it aside for that.
  const scratch = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "mo-install-size-"));
  try {
    const tarballs = join(scratch, "tarballs");
    const project = join(scratch, "project");
    mkdirSync(tarballs);
    mkdirSync(project);
    for (const name of wanted) {
      const dir = dirs.get(name);
      if (dir === undefined) throw new Error(`${name} is required by ${ENTRY} but is not a workspace package`);
      if (!existsSync(join(ROOT, dir, "dist"))) {
        throw new Error(`${name} has no dist/: run \`bun run --filter '*' build\` first`);
      }
      execFileSync("bun", ["pm", "pack", "--destination", tarballs, "--quiet"], { cwd: join(ROOT, dir), stdio: ["ignore", "ignore", "inherit"] });
    }
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "install-size", version: "1.0.0", private: true, type: "module" }));
    const files = readdirSync(tarballs).map((f) => join(tarballs, f));
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress", ...files], { cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const modules = join(project, "node_modules");
    return { bytes: bytesUnder(modules), rows: breakdown(modules), names: installedNames(modules), packed: wanted.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
const { bytes, rows, names, packed } = measure();
const mb = (n) => (n / MB).toFixed(1);

console.log(`install size: ${mb(bytes)} MB installing ${ENTRY} (${packed} workspace packages, ${names.length} top-level packages)`);
for (const row of rows.slice(0, 8)) console.log(`  ${mb(row.bytes).padStart(6)} MB  ${row.name}`);

const forbidden = Object.keys(FORBIDDEN).filter((name) => names.includes(name));
if (forbidden.length > 0) {
  fail(`installing ${ENTRY} put packages in the tree that it must not:\n${forbidden.map((n) => `    ${n}: ${FORBIDDEN[n]}`).join("\n")}`);
}

if (budget.platform !== platformKey()) {
  console.log(`install-size budget: ${mb(budget.budgetBytes)} MB is for ${budget.platform}; this is ${platformKey()}, so the number above is reported and not checked`);
  process.exit(0);
}

const onMain = mainBudget();
if (onMain !== undefined && budget.budgetBytes > onMain) {
  fail(`the budget rose: ${BUDGET_FILE} says ${mb(budget.budgetBytes)} MB and main says ${mb(onMain)} MB. The budget only moves down.`);
}

if (bytes > budget.budgetBytes) {
  fail(`the install is ${mb(bytes - budget.budgetBytes)} MB over the budget (${mb(bytes)} MB, budget ${mb(budget.budgetBytes)} MB). Find what grew in the list above; the budget is not the thing to change.`);
}

if (bytes < budget.budgetBytes - budget.slackBytes) {
  if (!update) {
    fail(`the install is ${mb(budget.budgetBytes - bytes)} MB under the budget (${mb(bytes)} MB, budget ${mb(budget.budgetBytes)} MB). Lower it, so the saving cannot be spent again: node scripts/check-install-size.mjs --update`);
  }
}

if (update) {
  if (bytes >= budget.budgetBytes) {
    console.log(`install-size budget: ${mb(budget.budgetBytes)} MB stays (measured ${mb(bytes)} MB; --update only lowers it)`);
  } else {
    writeFileSync(BUDGET_PATH, `${JSON.stringify({ ...budget, budgetBytes: bytes }, null, 2)}\n`);
    console.log(`install-size budget: lowered from ${mb(budget.budgetBytes)} MB to ${mb(bytes)} MB`);
  }
  process.exit(0);
}

console.log(`install-size budget: OK (${mb(bytes)} MB of ${mb(budget.budgetBytes)} MB)`);
