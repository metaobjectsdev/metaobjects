#!/usr/bin/env bun
/**
 * Regenerates `examples/showcase/generated/**` — the corpus metaobjects.dev
 * publishes — from `examples/showcase/metaobjects/`, once per port.
 *
 *   bun scripts/regen-showcase.ts               # write
 *   bun scripts/regen-showcase.ts --check       # fail if the committed tree is stale
 *   bun scripts/regen-showcase.ts --all-ports   # refuse to skip a port (release preflight)
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
 * Two ports need only bun; python needs `uv`, csharp needs `dotnet`. A port whose
 * toolchain is absent is SKIPPED and named in the output — never silently. Pass
 * `--all-ports` to turn a skip into a failure; the release preflight does.
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

/** The inputs a pristine regen needs. `.gen-state` is deliberately absent. */
const INPUTS = ["metaobjects", "templates", "metaobjects.config.ts"];

interface Port {
  /** Directory under `generated/` this port owns. */
  readonly name: string;
  /** Executable that must be on PATH, or null when bun alone suffices. */
  readonly tool: string | null;
  /** Generates into `<project>/generated/<name>`. Throws on failure. */
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
    tool: null,
    generate: (project) => run(["bun", META_CLI, "gen", "--cwd", project]),
  },
  {
    // Python and C# are flag-only: metadata dir in, --out dir out. Neither needs
    // project scaffolding, so neither gets any.
    name: "python",
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
];

function selectPorts(): Port[] {
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
  for (const p of ports) {
    const a = join(fresh, p.name);
    const b = join(committed, p.name);
    const fa = listFiles(a);
    const fb = listFiles(b);
    for (const rel of fb.filter((f) => !fa.includes(f))) {
      problems.push(`${p.name}/${rel}: committed but no longer generated`);
    }
    for (const rel of fa.filter((f) => !fb.includes(f))) {
      problems.push(`${p.name}/${rel}: generated but not committed`);
    }
    for (const rel of fa.filter((f) => fb.includes(f))) {
      if (readFileSync(join(a, rel), "utf8") !== readFileSync(join(b, rel), "utf8")) {
        problems.push(`${p.name}/${rel}: differs from a pristine regen`);
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
  if (ALL_PORTS || ports.length === PORTS.length) {
    rmSync(join(SHOWCASE, "generated"), { recursive: true, force: true });
    rmSync(join(SHOWCASE, ".metaobjects", ".gen-state"), { recursive: true, force: true });
  } else {
    console.log("  ! partial run — keeping existing output; only the ports above are rewritten");
  }
  generateInto(SHOWCASE, ports);
  console.log("✓ examples/showcase/generated is up to date");
}
