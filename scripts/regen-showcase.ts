#!/usr/bin/env bun
/**
 * Regenerates `examples/showcase/generated/**` — the corpus metaobjects.dev
 * publishes — from `examples/showcase/metaobjects/`, once per port.
 *
 *   bun scripts/regen-showcase.ts               # write
 *   bun scripts/regen-showcase.ts --check       # fail if the committed tree is stale
 *   bun scripts/regen-showcase.ts --all-ports   # refuse to skip a port (release preflight)
 *
 * BUILD FIRST. The ts port shells out to the workspace `meta`, and the CLI deliberately
 * prefers a package's compiled `dist/` over its `.ts` source when Bun's export condition
 * offers both (see `resolveCliPkg` in cli/src/lib/load-metaobjects-config.ts). So on a
 * tree whose `dist/` predates a codegen change this script regenerates through the OLD
 * emitter, reports every file `unchanged`, and `--check` passes against committed output
 * the current source would no longer produce — a vacuous green. Run
 * `bun run --filter '*' build` first. `ci-local.sh` has `gate_ts_build_typecheck`, but it
 * is in a different lane, so `--only gates` does not imply it.
 *   bun scripts/regen-showcase.ts --bun-only    # only the ports bun alone can drive
 *
 * The website claims these files are real `meta gen` output. A stale tree is a
 * stale claim on a public page, which is why `--check` runs in the release
 * preflight.
 *
 * ── Why `--check` regenerates PRISTINE ───────────────────────────────────────
 *
 * Neither `git status` after a regen nor `meta verify --codegen` can see a
 * COMMITTED hand edit inside a generated file. `meta gen` three-way-merges hand
 * edits by design, reports `merged`, and leaves the tree clean with the recorded
 * hash in sync — correct for a consumer project, wrong for this one, whose whole
 * contract is that the committed output is PURELY generated. Measured in Task 1:
 * renaming a table in the committed output left both signals green.
 *
 * So `--check` copies the INPUTS (model, templates, config — deliberately not
 * `.gen-state`) into a temp tree, generates there, and byte-compares. With no
 * merge base the generator emits exactly what it produces, and the gate never
 * writes to the tree it is checking.
 *
 * ── Ports ────────────────────────────────────────────────────────────────────
 *
 * Two ports need only bun; python needs `uv`, csharp needs `dotnet`, and the JVM
 * pair needs `mvn`. A port whose toolchain is absent is SKIPPED and named in the
 * output — never silently. Pass `--all-ports` to turn a skip into a failure; the
 * release preflight does.
 *
 * Java and Kotlin arrive together because they have no standalone codegen CLI: on
 * the JVM, codegen runs in the build tool (docs/features/cli.md), so one
 * `mvn metaobjects:generate` over `examples/showcase/jvm/pom.xml` drives both. That
 * pom names the plugin by VERSION rather than building it, so the JVM port needs the
 * artifacts resolvable — from Maven Central at a released version, or from
 * `cd server/java && mvn install` while the reactor sits on a -SNAPSHOT.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SHOWCASE = resolve(REPO, "examples/showcase");
const META_CLI = resolve(REPO, "server/typescript/packages/cli/bin/meta.ts");

const CHECK = process.argv.includes("--check");
const ALL_PORTS = process.argv.includes("--all-ports");
// The gates lane is guarded on bun alone and is the documented pre-PR command, so it
// must not shell out to mvn/dotnet/uv — Maven alone costs ~20s, more than every other
// port together. `--bun-only` scopes the run to ts + sql and NAMES what it left out;
// the release preflight runs `--all-ports`, which refuses to leave anything out.
const BUN_ONLY = process.argv.includes("--bun-only");
if (BUN_ONLY && ALL_PORTS) {
  console.error("✗ --bun-only and --all-ports contradict each other");
  process.exit(2);
}

/** The inputs a pristine regen needs. `.gen-state` is deliberately absent. */
const INPUTS = ["metaobjects", "templates", "metaobjects.config.ts", "jvm"];

interface Port {
  /** Label for the output line. */
  readonly name: string;
  /**
   * Directories under `generated/` this port owns. Usually one; the JVM entry owns
   * two, because a single Maven run drives the Java and Kotlin generators together.
   */
  readonly dirs: readonly string[];
  /** Executable that must be on PATH, or null when bun alone suffices. */
  readonly tool: string | null;
  /** Generates into `<project>/generated/<dir>` for each of its dirs. Throws on failure. */
  generate(project: string): void;
}

function run(argv: string[], opts: { cwd?: string } = {}): void {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd ?? REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(
      `${argv.join(" ")}\n  exit ${r.status}\n${r.stdout ?? ""}${r.stderr ?? ""}`,
    );
  }
}

function have(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

const PORTS: Port[] = [
  {
    // `--cwd` makes this a project run: outDir, dialect, extStyle and the
    // generator list all come from metaobjects.config.ts, exactly as an
    // adopter's `meta gen` does.
    name: "ts",
    dirs: ["ts"],
    tool: null,
    generate: (project) => run(["bun", META_CLI, "gen", "--cwd", project]),
  },
  {
    // Python and C# are flag-only: metadata dir in, --out dir out. Neither needs
    // project scaffolding, so neither gets any.
    name: "python",
    dirs: ["python"],
    tool: "uv",
    generate: (project) =>
      run([
        "uv", "run", "--project", resolve(REPO, "server/python"),
        "metaobjects", "gen", join(project, "metaobjects"),
        "--out", join(project, "generated", "python"),
      ]),
  },
  {
    // `dotnet run --project` rather than the installed `dotnet meta` tool: the
    // tool would have to be packed and installed at the current version first,
    // and this generates from the working tree, which is what a gate wants.
    name: "csharp",
    dirs: ["csharp"],
    tool: "dotnet",
    generate: (project) =>
      run([
        "dotnet", "run", "--project", resolve(REPO, "server/csharp/MetaObjects.Cli"),
        "-v", "q", "--",
        "gen", join(project, "metaobjects"),
        "--out", join(project, "generated", "csharp"),
      ]),
  },
  {
    // Schema is Node-only (ADR-0015), so SQL is the migrate engine, not a port
    // codegen. This is the documented greenfield flow — introspect an empty DB,
    // diff against the metadata, emit CREATE TABLE — run against a THROWAWAY
    // sqlite file so the corpus carries no ledger or snapshot state.
    //
    // The emitted directory is `<timestamp>-init/`, which no rebuild can
    // reproduce. Only the SQL bodies are committed, under a fixed `init/`; the
    // bodies themselves are byte-identical to what the engine wrote.
    name: "sql",
    dirs: ["sql"],
    tool: null,
    generate: (project) => {
      const scratch = mkdtempSync(join(tmpdir(), "showcase-migrate-"));
      try {
        const outDir = join(scratch, "migrations");
        run([
          "bun", META_CLI, "migrate", "--cwd", project,
          "--from-db", "--db", `file:${join(scratch, "dev.sqlite")}`,
          // Matches `dialect` in metaobjects.config.ts.
          "--dialect", "sqlite",
          "--slug", "init", "--out-dir", outDir,
        ]);
        const emitted = readdirSync(outDir).filter((d) => d.endsWith("-init"));
        if (emitted.length !== 1) {
          throw new Error(
            `expected exactly one <timestamp>-init migration, got ${emitted.length}`,
          );
        }
        const dest = join(project, "generated", "sql", "init");
        mkdirSync(dest, { recursive: true });
        for (const f of ["up.sql", "down.sql"]) {
          cpSync(join(outDir, emitted[0]!, f), join(dest, f));
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  },
  {
    // One Maven run, two output trees. The pom pins the plugin version, which
    // scripts/check-pom-versions.sh keeps in lockstep with the reactor — this
    // project sits OUTSIDE the reactor, so `mvn versions:set` never touches it and
    // a missed bump would silently regenerate against the PREVIOUS release.
    name: "jvm",
    dirs: ["java", "kotlin"],
    tool: "mvn",
    generate: (project) =>
      run(["mvn", "-q", "metaobjects:generate"], { cwd: join(project, "jvm") }),
  },
];

function selectPorts(): Port[] {
  if (BUN_ONLY) {
    for (const p of PORTS.filter((p) => p.tool)) {
      console.log(`  ⊘ ${p.name} — --bun-only, NOT checked`);
    }
    return PORTS.filter((p) => !p.tool);
  }
  const skipped = PORTS.filter((p) => p.tool && !have(p.tool));
  if (skipped.length && ALL_PORTS) {
    console.error(
      `✗ --all-ports: missing toolchain for ${skipped.map((p) => `${p.name} (${p.tool})`).join(", ")}`,
    );
    process.exit(1);
  }
  for (const p of skipped) {
    console.log(`  ⊘ ${p.name} — no \`${p.tool}\` on PATH, NOT checked`);
  }
  return PORTS.filter((p) => !skipped.includes(p));
}

function generateInto(project: string, ports: Port[]): void {
  for (const p of ports) {
    p.generate(project);
    // A generator that wrote nothing and exited 0 is the failure this whole corpus
    // exists to catch, and it is not hypothetical: the Maven plugin ran both JVM
    // generators against an empty model, wrote zero files, and reported BUILD
    // SUCCESS. In write mode that would silently EMPTY a committed tree, and `✓`
    // would still print. A port that produced nothing did not succeed.
    const empty = p.dirs.filter((d) => listFiles(join(project, "generated", d)).length === 0);
    if (empty.length) {
      throw new Error(
        `${p.name} exited 0 but wrote no files to ${empty.map((d) => `generated/${d}`).join(", ")}`,
      );
    }
    console.log(`  ✓ ${p.name}`);
  }
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function pristineProject(): string {
  const tmp = mkdtempSync(join(tmpdir(), "showcase-pristine-"));
  for (const item of INPUTS) cpSync(join(SHOWCASE, item), join(tmp, item), { recursive: true });
  cpSync(join(SHOWCASE, ".metaobjects", "config.json"),
         join(tmp, ".metaobjects", "config.json"), { recursive: true });
  return tmp;
}

function diffTrees(fresh: string, committed: string, ports: Port[]): string[] {
  const problems: string[] = [];
  // Scoped per port: a skipped port's committed output must not read as an
  // orphan just because its toolchain is absent.
  for (const dir of ports.flatMap((p) => p.dirs)) {
    const a = join(fresh, dir);
    const b = join(committed, dir);
    const fa = listFiles(a);
    const fb = listFiles(b);
    for (const rel of fb.filter((f) => !fa.includes(f))) {
      problems.push(`${dir}/${rel}: committed but no longer generated`);
    }
    for (const rel of fa.filter((f) => !fb.includes(f))) {
      problems.push(`${dir}/${rel}: generated but not committed`);
    }
    for (const rel of fa.filter((f) => fb.includes(f))) {
      if (readFileSync(join(a, rel), "utf8") !== readFileSync(join(b, rel), "utf8")) {
        problems.push(`${dir}/${rel}: differs from a pristine regen`);
      }
    }
  }
  return problems;
}

const ports = selectPorts();

if (CHECK) {
  const tmp = pristineProject();
  try {
    generateInto(tmp, ports);
    const problems = diffTrees(join(tmp, "generated"), join(SHOWCASE, "generated"), ports);
    if (problems.length) {
      console.error(
        "✗ showcase output is stale — the website would publish a hand-edited or " +
        "out-of-date file as generated output.\n" +
        problems.map((p) => `    ${p}`).join("\n") +
        "\n  Run `bun run regen:showcase`, review the diff, and commit.",
      );
      process.exit(1);
    }
    console.log("✓ showcase output is fresh");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  // Write mode clears the output AND the merge base, so what lands is what a
  // pristine regen produces — the contract `--check` then enforces.
  if (!BUN_ONLY && (ALL_PORTS || ports.length === PORTS.length)) {
    rmSync(join(SHOWCASE, "generated"), { recursive: true, force: true });
    rmSync(join(SHOWCASE, ".metaobjects", ".gen-state"), { recursive: true, force: true });
  } else {
    console.log("  ! partial run — keeping existing output; only the ports above are rewritten");
  }
  generateInto(SHOWCASE, ports);
  console.log("✓ examples/showcase/generated is up to date");
}
