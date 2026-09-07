#!/usr/bin/env bun
/**
 * Reference-template lint gate.
 *
 * Every reference template is an ADOPTER'S FILE. `meta init` copies five of them into
 * a new project and `meta eject <name>` copies any of them on demand (FR-040 §4.2(a));
 * from that moment the adopter owns the copy, commits it, and — if they lint their repo
 * at all — lints it. So a lint error in a reference template is not a style opinion
 * about this repo's source: it is an error the tool WROTE INTO someone else's project,
 * on a file they did not author, on the first run.
 *
 * That is exactly the friction 1.0's ownership story cannot afford. Owning a generator
 * is only cheap if re-syncing an owned copy against a newer reference is cheap, and it
 * stops being cheap the moment the adopter's first act after `meta eject` is a lint
 * fight over findings they did not cause. Six templates shipped that way: four
 * `noNonNullAssertion` in barrel.ts, `noUnusedTemplateLiteral` in queries.ts,
 * `useTemplate` in routes-hono.ts, `noConfusingVoidType` in the three tanstack
 * templates and `useImportType` in five files — 14 findings, every one of them
 * trivially fixable with no behaviour change.
 *
 * Nothing could see them. The templates are excluded from each package's BUILD
 * tsconfig, this repo ships no `biome.json` of its own (biome is a dependency here for
 * `formatTs`, the codegen format pass — not a repo linter), and the gates that DO read
 * these files — `test/reference-byte-identical.test.ts` in each package — compare
 * EMITTED OUTPUT, which is byte-identical whether a template asserts non-null or
 * narrows. The only reader who ever saw them was an adopter.
 *
 * DISCOVERY — by the marker the file itself carries, not by path:
 *   A template's first line is `// REFERENCE TEMPLATE — copy this into your repo`.
 *   That line IS the contract: a file telling a reader to own it is a file that must
 *   lint clean where it lands. Keying on it covers every copy of that text in the tree,
 *   and there are four kinds — each package's `src/reference/`, the private
 *   `test-generators` package (tests that need an adopter's owned generators),
 *   and the two `examples/<name>/codegen/generators/` scaffolds a reader copies from.
 *   All four carried the identical findings at identical line numbers, so a path-keyed
 *   gate would have fixed one and left three teaching the errors.
 *
 * SCOPE — lint only, deliberately NOT `biome check`:
 *   A lint finding is an ERROR the adopter must act on. Formatting and import order are
 *   a diff their own formatter owns and re-runs — every one of these files differs from
 *   biome's default 80-column formatter simply because this repo writes wider lines.
 *   Gating format here would reformat the templates to one project's taste and still
 *   not match the next project's. Gating LINT holds the line that actually matters:
 *   `meta eject` never writes an error into a repo.
 *
 * The ruleset is biome's `recommended: true` at the version this workspace pins, run
 * against the files IN PLACE so every diagnostic names the real path. An adopter on a
 * different linter (or a different biome) may still see something; the promise this
 * gate makes is the reproducible one.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const PACKAGE_ROOTS = ["server/typescript/packages", "client/web/packages"];

/** The line a reference template opens with. Also the reason it must lint clean. */
export const TEMPLATE_MARKER = "REFERENCE TEMPLATE — copy this into your repo";

/** Every TRACKED `.ts` file whose first line carries the marker, repo-relative and
 *  sorted. `git ls-files` rather than a filesystem walk: it costs one process, and it
 *  cannot wander into node_modules, dist, or a sibling worktree under `.claude/`. */
export async function discoverTemplates(repo: string = REPO): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", "*.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ls-files failed in ${repo}`);
  const found: string[] = [];
  for (const rel of out.split("\0")) {
    if (rel === "") continue;
    const abs = join(repo, rel);
    if (!existsSync(abs)) continue;              // deleted-but-still-indexed
    const firstLine = readFileSync(abs, "utf8").split("\n", 1)[0] ?? "";
    if (firstLine.includes(TEMPLATE_MARKER)) found.push(rel);
  }
  return found.sort();
}

/** biome is a dependency of the codegen packages (it runs the `formatTs` pass), so a
 *  binary is present after `bun install`. Any of them is the same pinned version. */
export function resolveBiomeBin(repo: string = REPO): string | undefined {
  for (const root of PACKAGE_ROOTS) {
    const rootDir = join(repo, root);
    if (!existsSync(rootDir)) continue;
    for (const pkg of readdirSync(rootDir)) {
      const bin = join(rootDir, pkg, "node_modules", ".bin", "biome");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

/** A throwaway directory holding nothing but a stock recommended-rules `biome.json`.
 *  `--config-path` at a DIRECTORY disables biome's normal config discovery, so what
 *  runs is this ruleset and not whatever a future repo-level config might say. */
export function writeStockConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-ref-biome-"));
  writeFileSync(
    join(dir, "biome.json"),
    `${JSON.stringify({
      $schema: "https://biomejs.dev/schemas/1.9.4/schema.json",
      linter: { enabled: true, rules: { recommended: true } },
    }, null, 2)}\n`,
  );
  return dir;
}

export interface LintResult { ok: boolean; output: string }

/** Run `biome lint` over `paths` with the stock config. `--max-diagnostics=none`
 *  because biome caps at 20 by default, and a capped gate reports a SAMPLE. */
export async function lintPaths(bin: string, configDir: string, paths: string[], cwd: string = REPO): Promise<LintResult> {
  const proc = Bun.spawn([bin, "lint", `--config-path=${configDir}`, "--max-diagnostics=none", ...paths], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, output: `${stdout}${stderr}` };
}

if (import.meta.main) {
  const templates = await discoverTemplates();
  if (templates.length === 0) {
    console.error(`✖ no file in the tree opens with "${TEMPLATE_MARKER}".`);
    console.error("  Discovery is broken, or the marker was reworded. A gate that finds");
    console.error("  nothing passes silently; this one refuses instead.");
    process.exit(1);
  }

  const bin = resolveBiomeBin();
  if (!bin) {
    console.error("✖ no biome binary in any package's node_modules/.bin — run `bun install` first.");
    process.exit(1);
  }

  const configDir = writeStockConfig();
  try {
    const { ok, output } = await lintPaths(bin, configDir, templates);
    if (!ok) {
      console.error(output.trimEnd());
      console.error(
        "\n✖ reference templates do not lint clean under biome's recommended rules." +
        "\n\nEvery file above tells its reader to copy it and own it, so each finding is one" +
        "\n`meta eject` writes into an adopter's repo — their lint error, on code they did" +
        "\nnot write. Fix the template, not the adopter's config, and apply the same fix to" +
        "\nevery copy (the gate lists them all). These fixes are behaviour-preserving, so" +
        "\neach package's test/reference-byte-identical.test.ts stays green; run it after.\n",
      );
      process.exit(1);
    }
    console.log(`reference-template lint: OK (${templates.length} template(s), recommended rules)`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
