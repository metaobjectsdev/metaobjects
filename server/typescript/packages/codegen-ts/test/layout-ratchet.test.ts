// The layout ratchet (ADR-0063): generator source never types layout; the writer does.
//
// Three parts:
//   1. the analyzer's own cases — layout it must catch, and writer-based code it must pass;
//   2. the scope rule — which files are generator source, by rule, not by list;
//   3. the ratchet over the real packages — every file with hand-typed layout is on the
//      allowlist with a reason, every allowlisted file still needs its entry, and the
//      allowlist only shrinks.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { analyzeSource, type FindingKind, isGeneratorSource, SCANNED_PACKAGES } from "./layout-ratchet/analyze.js";

const kinds = (source: string, file = "fixture.ts"): FindingKind[] => analyzeSource(file, source).map((f) => f.kind);

// ── 1. the analyzer ──────────────────────────────────────────────────────────────────────

describe("the analyzer catches hand-typed layout", () => {
  const caught: [string, string, FindingKind[]][] = [
    ["a newline escape in a string", `const s = "a\\nb";`, ["newline-literal"]],
    ["a hex newline escape", `const s = "a\\x0ab";`, ["newline-literal"]],
    ["a carriage return", `const s = "a\\r";`, ["newline-literal"]],
    ["a line break inside a template literal", "const s = `a\nb`;", ["newline-literal"]],
    ["a line break in a ts-poet code template", "const c = code`\nexport const ${name} = 1;\n`;", ["newline-literal", "newline-literal"]],
    ["a line break after a substitution", "const s = `${a}\n${b}`;", ["newline-literal"]],
    ["a string that starts with two spaces", `rows.push("  " + name);`, ["indent-literal"]],
    ["a string that starts with a tab", `rows.push("\\tx");`, ["indent-literal"]],
    ["a template that starts with an indentation run", "rows.push(`    ${name}: string;`);", ["indent-literal"]],
    ["a join on a newline literal", `out.join("\\n");`, ["newline-join", "newline-literal"]],
    ["a join on a comma-newline literal", `rows.join(",\\n");`, ["newline-join", "newline-literal"]],
    ["a joinCode with a newline separator", `joinCode(parts, { on: "\\n" });`, ["newline-join", "newline-literal"]],
    ["an indentation repeat", `const pad = "  ".repeat(depth);`, ["indent-repeat", "indent-literal"]],
    ["a single-space repeat", `const pad = " ".repeat(depth * 2);`, ["indent-repeat"]],
  ];
  for (const [name, source, expected] of caught) {
    test(name, () => expect(kinds(source).sort()).toEqual([...expected].sort()));
  }

  // A constant cannot hide a line break: the declaration is a finding, AND so is every use.
  test("a newline hidden behind a same-file constant is caught where it is used", () => {
    const source = ["const NL = \"\\n\";", "export const out = lines.join(NL);"].join("\n");
    const found = analyzeSource("fixture.ts", source);
    expect(found.map((f) => [f.kind, f.line])).toEqual([
      ["newline-literal", 1],
      ["newline-join", 2],
    ]);
  });

  test("the constant may be built from other constants or held in an object", () => {
    const source = [
      "const NL = \"\\n\";",
      "const SEP = \",\" + NL;",
      "const LAYOUT = { rowSep: `${SEP}` } as const;",
      "rows.join(SEP);",
      "rows.join(LAYOUT.rowSep);",
      "joinCode(chunks, { on: NL });",
    ].join("\n");
    expect(analyzeSource("fixture.ts", source).filter((f) => f.kind === "newline-join").map((f) => f.line)).toEqual([4, 5, 6]);
  });

  test("an indentation unit hidden behind a constant is caught at the repeat", () => {
    const source = ["const UNIT = \" \";", "const pad = UNIT.repeat(4);"].join("\n");
    expect(kinds(source)).toEqual(["indent-repeat"]);
  });

  test("either branch of a conditional separator counts", () => {
    expect(kinds(`rows.join(compact ? ", " : ",\\n");`).sort()).toEqual(["newline-join", "newline-literal"]);
  });

  test("findings carry the line and column of the node", () => {
    const [f] = analyzeSource("fixture.ts", ["const a = 1;", "  const s = `x", "y`;"].join("\n"));
    expect([f!.line, f!.column]).toEqual([2, 13]);
  });
});

describe("the analyzer passes code that leaves layout to the writer", () => {
  test("a generator written on TsWriter has no findings", () => {
    const source = `
      import { props, arr, str, TsWriter } from "@metaobjectsdev/codegen-ts/engine";

      // Comments may say anything, including "\\n" and
      //     indented text: a comment is never a node.
      /*
       *   a block comment, indented
       */
      export function renderAllowlist(entity: MetaObject): string {
        const w = new TsWriter();
        const FilterAllowlist = w.useType("FilterAllowlist", "@metaobjectsdev/runtime-ts");
        w.block(\`export const \${entity.name}FilterAllowlist = {\`, () => {
          for (const f of entity.fields()) {
            w.line(\`\${f.name}: \`, props().set("ops", [arr(ops(f).map(str)), " as const"]), ",");
          }
        }, \`} as const satisfies \${FilterAllowlist};\`);
        w.blank();
        w.text(\`
          export function check() {
            return true;
          }
        \`);
        return w.toString();
      }
    `;
    expect(analyzeSource("fixture.ts", source)).toEqual([]);
  });

  test("a line break used as a search pattern is not output", () => {
    const source = [
      "const parts = description.split(\"\\n\");",
      "if (body.includes(\"\\n\")) flag();",
      "const flat = body.replace(\"\\r\\n\", \" \").replaceAll(\"\\n\", \" \");",
      "const at = body.indexOf(\"  \");",
    ].join("\n");
    expect(analyzeSource("fixture.ts", source)).toEqual([]);
  });

  test("a replacement that writes a line break is still output", () => {
    expect(kinds(`const s = body.replace(";", ";\\n");`)).toEqual(["newline-literal"]);
  });

  test("type positions are not values", () => {
    expect(kinds(`type Sep = "\\n" | "  ";\nlet s: "\\n";`)).toEqual([]);
  });

  test("single spaces, joins on a space and spacing after a substitution are not layout", () => {
    const source = ["const a = names.join(\", \");", "const b = `${left}  ${right}`;", "const c = \" \" + x;"].join("\n");
    expect(analyzeSource("fixture.ts", source)).toEqual([]);
  });

  test("a parameter shadowing a layout constant is not resolved to it", () => {
    const source = ["function f(SEP: string) {", "  return rows.join(SEP);", "}", "const SEP = \", \";"].join("\n");
    expect(analyzeSource("fixture.ts", source)).toEqual([]);
  });
});

// ── 2. the scope rule ────────────────────────────────────────────────────────────────────

describe("which files are generator source", () => {
  const cases: [string, boolean][] = [
    ["codegen-ts/src/templates/routes-file.ts", true],
    ["codegen-ts-react/src/templates/form-file.ts", true],
    ["codegen-ts-angular/src/templates/grid-file.ts", true],
    ["codegen-ts/src/reference/routes.ts", true],
    ["codegen-ts/src/writer/code-writer.ts", false],
    ["codegen-ts/src/writer/ts-writer.ts", false],
    ["codegen-ts/test/routes.test.ts", false],
    ["codegen-ts/src/templates/routes.test.ts", false],
    ["codegen-ts/src/test/helper.ts", false],
    ["codegen-ts/src/render-engine/embedded-templates.generated.ts", false],
    ["codegen-ts/src/index.d.ts", false],
    ["runtime-ts/src/filter.ts", false],
    ["codegen-ts/README.md", false],
  ];
  for (const [path, scanned] of cases) {
    test(`${path} is ${scanned ? "" : "not "}scanned`, () => expect(isGeneratorSource(path)).toBe(scanned));
  }
});

// ── 3. the ratchet over the real packages ────────────────────────────────────────────────

const PACKAGES = resolve(import.meta.dir, "../..");
const REPO = resolve(PACKAGES, "../../..");
const ALLOWLIST_PATH = resolve(import.meta.dir, "layout-ratchet/allowlist.json");
const ALLOWLIST_REL = relative(REPO, ALLOWLIST_PATH).replaceAll("\\", "/");

interface Allowlist {
  unconverted: Record<string, string>;
  exempt: Record<string, string>;
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist;
const entries = { ...allowlist.unconverted, ...allowlist.exempt };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const scanned = SCANNED_PACKAGES.flatMap((p) => walk(join(PACKAGES, p, "src")))
  .map((f) => relative(PACKAGES, f).replaceAll("\\", "/"))
  .filter(isGeneratorSource)
  .sort();
const findings = new Map(scanned.map((f) => [f, analyzeSource(f, readFileSync(join(PACKAGES, f), "utf8"))]));

describe("the layout ratchet", () => {
  test("it reads every scanned package", () => {
    for (const p of SCANNED_PACKAGES) expect(scanned.some((f) => f.startsWith(`${p}/`)), p).toBe(true);
  });

  test("no generator source types layout unless its file is allowlisted", () => {
    const offenders = [...findings]
      .filter(([file, found]) => found.length > 0 && !(file in entries))
      .map(([file, found]) => [file, ...found.map((f) => `  ${f.line}:${f.column} ${f.kind} ${f.excerpt}`)].join("\n"));
    expect(
      offenders,
      "Write these lines through TsWriter (src/writer/) instead of typing line breaks or indentation. " +
        "A file is never added to the allowlist: it only shrinks.",
    ).toEqual([]);
  });

  // Generator source outside the scanned packages escapes the ratchet. That is how the
  // private `test-generators` package (owned copies of the reference generators, retired in
  // 1.3.0) sat outside it, so any package that carries a reference generator is scanned.
  test("no package outside the scanned set carries a reference generator", () => {
    const MARKER = "// REFERENCE TEMPLATE";
    const unscanned = readdirSync(PACKAGES).filter(
      (p) => !(SCANNED_PACKAGES as readonly string[]).includes(p) && existsSync(join(PACKAGES, p, "src")),
    );
    const outside = unscanned.flatMap((p) =>
      walk(join(PACKAGES, p, "src"))
        .filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").startsWith(MARKER))
        .map((f) => relative(PACKAGES, f).replaceAll("\\", "/")),
    );
    expect(outside, "add the package to SCANNED_PACKAGES (layout-ratchet/analyze.ts)").toEqual([]);
  });

  test("every allowlisted file still needs its entry", () => {
    const stale = Object.keys(entries).filter((file) => (findings.get(file)?.length ?? 0) === 0);
    expect(stale, "these files no longer type layout (or no longer exist): remove their allowlist entries").toEqual([]);
  });

  test("every allowlisted path is generator source that exists", () => {
    for (const file of Object.keys(entries)) {
      expect(isGeneratorSource(file), `${file} is not in the ratchet's scope`).toBe(true);
      expect(existsSync(join(PACKAGES, file)), `${file} does not exist`).toBe(true);
    }
  });

  test("every entry carries a written reason", () => {
    for (const [file, reason] of Object.entries(entries)) expect(reason.length, `${file} needs a reason`).toBeGreaterThan(40);
  });

  test("a file is either unconverted or exempt, never both, and each list is sorted", () => {
    expect(Object.keys(allowlist.unconverted).filter((f) => f in allowlist.exempt)).toEqual([]);
    for (const list of [allowlist.unconverted, allowlist.exempt]) expect(Object.keys(list)).toEqual(Object.keys(list).sort());
  });

  // The allowlist may only shrink. Compared with the copy at the merge base of every
  // integration branch this checkout knows: an entry that is not there was added here.
  const bases = mergeBaseAllowlists();
  test.skipIf(bases === undefined)("the allowlist only shrinks", () => {
    for (const { ref, list } of bases!) {
      expect(growth(list, allowlist), `the allowlist grew since the merge base with ${ref}; convert the file to the writer instead`).toEqual([]);
    }
  });

  test("growth is an added entry, or an unconverted file relabelled exempt; removal is not", () => {
    const before: Allowlist = { unconverted: { "a.ts": "r", "b.ts": "r" }, exempt: { "c.ts": "r" } };
    expect(growth(before, { unconverted: { "a.ts": "r" }, exempt: {} })).toEqual([]);
    expect(growth(before, { unconverted: { "a.ts": "r", "d.ts": "r" }, exempt: { "c.ts": "r" } })).toEqual(["added d.ts"]);
    expect(growth(before, { unconverted: { "a.ts": "r" }, exempt: { "b.ts": "r", "c.ts": "r" } })).toEqual(["relabelled b.ts as exempt"]);
  });
});

/** How `now` grew relative to `before`: entries that are new, and unconverted files relabelled exempt. */
function growth(before: Allowlist, now: Allowlist): string[] {
  const had = new Set([...Object.keys(before.unconverted), ...Object.keys(before.exempt ?? {})]);
  return [
    ...Object.keys({ ...now.unconverted, ...now.exempt }).filter((f) => !had.has(f)).map((f) => `added ${f}`),
    ...Object.keys(now.exempt).filter((f) => f in before.unconverted).map((f) => `relabelled ${f} as exempt`),
  ];
}

/**
 * The allowlist as it stood at the merge base of HEAD with each integration branch
 * (`origin/main`, `origin/release/*`). `undefined` when git or those refs are unavailable
 * (an export or a shallow clone), in which case the shrink check is skipped and says so.
 */
function mergeBaseAllowlists(): { ref: string; list: Allowlist }[] | undefined {
  const git = (...args: string[]): string | undefined => {
    const r = Bun.spawnSync(["git", "-C", REPO, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
  };
  const refs = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main", "refs/remotes/origin/release/");
  if (refs === undefined || refs === "") return undefined;
  const out: { ref: string; list: Allowlist }[] = [];
  let reachable = false;
  for (const ref of refs.split(/\s+/)) {
    const base = git("merge-base", "HEAD", ref);
    if (base === undefined) continue;
    reachable = true;
    const text = git("show", `${base}:${ALLOWLIST_REL}`);
    if (text !== undefined) out.push({ ref, list: JSON.parse(text) as Allowlist });
  }
  return reachable ? out : undefined;
}
