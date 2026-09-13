// The codegen skill's prose is grounded in the LIVE catalog.
//
// The design's rule is that the skill teaches a PROCEDURE, not a list: recipes name
// layers, members come from `meta gen --list`. A list in prose goes stale the day a
// generator is added or renamed, and the reader has no way to tell — which is the same
// failure the `--probe` design exists to remove one level down.
//
// So two things are checked, and only two, because a broader "every backticked token
// must be real" sweep over prose collides with ordinary English:
//
//   1. Every generator name the skill hands to a COMMAND — `meta eject a b c`,
//      `--generators a,b,c` — is a real stable name. These are the tokens a reader will
//      literally type, so a renamed generator breaks them concretely.
//   2. Every layer the skill names is one of the six.
//
// The authority for (1) is the cross-port MANIFEST, not the composed TypeScript catalog:
// this skill carries a reference fragment per port, and the C# fragment legitimately
// names `db-context`, which no TypeScript slice registers.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERATOR_LAYERS } from "@metaobjectsdev/codegen-ts";
import { knownLibraryTokens } from "@metaobjectsdev/metadata/library";

const REPO_ROOT = join(import.meta.dir, "../../../../..");
const SKILL_ROOT = join(REPO_ROOT, "agent-context/skills/metaobjects-codegen");
/** FR-043 §4 puts the mirror of the library step here, so its tokens are gated too. */
const AUTHORING_ROOT = join(REPO_ROOT, "agent-context/skills/metaobjects-authoring");

/** Every stable name, in every port — the manifest, not one port's slice. */
const MANIFEST_NAMES: ReadonlySet<string> = new Set(
  Object.keys(
    (
      JSON.parse(
        readFileSync(
          join(REPO_ROOT, "fixtures/generator-registry-conformance/registry.json"),
          "utf8",
        ),
      ) as { generators: Record<string, unknown> }
    ).generators,
  ),
);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(abs));
    else if (entry.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** Placeholders a command example legitimately uses in place of a real name. */
const PLACEHOLDERS = new Set([
  "<name>", "<names...>", "<name>...", "<names>", "<a,b,c>", "<generator>", "<generators>",
  "a", "b", "c", "...",
]);

interface Named {
  file: string;
  token: string;
  line: string;
}

/** Generator names handed to `meta eject` / `--generators` anywhere in the skill. */
function namesInCommands(files: readonly string[]): Named[] {
  const found: Named[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      // `meta eject entity queries routes` — bare tokens up to a trailing shell
      // comment, a backtick, or a table cell boundary.
      for (const m of line.matchAll(/\b(?:meta|metaobjects|dotnet meta)\s+eject\s+([^`\n|#]*)/g)) {
        const toks = (m[1] ?? "").trim().split(/\s+/);
        for (let i = 0; i < toks.length; i++) {
          const tok = toks[i]!;
          if (tok.startsWith("--")) {
            // Skip the flag AND its value: `--format json` must not read `json` as a
            // generator name. A `--flag=value` form carries its own value already.
            if (!tok.includes("=")) i++;
            continue;
          }
          if (tok === "" || PLACEHOLDERS.has(tok)) continue;
          found.push({ file, token: tok, line: line.trim() });
        }
      }
      // `--generators entity,routes` / `--generators <a,b,c>`
      for (const m of line.matchAll(/--generators[= ]+([A-Za-z0-9,._<>-]+)/g)) {
        const arg = (m[1] ?? "").trim();
        if (PLACEHOLDERS.has(arg)) continue;
        for (const tok of arg.split(",")) {
          if (tok === "" || PLACEHOLDERS.has(tok)) continue;
          found.push({ file, token: tok, line: line.trim() });
        }
      }
    }
  }
  return found;
}

describe("the codegen skill is grounded in the live catalog", () => {
  const files = markdownFiles(SKILL_ROOT);

  test("the skill was actually found and read", () => {
    // Guards every assertion below from passing over an empty file list — the way a
    // grounding gate silently stops gating.
    expect(files.length).toBeGreaterThan(3);
  });

  test("every generator name the skill puts in a command is a real stable name", () => {
    const unknown = namesInCommands(files)
      .filter((n) => !MANIFEST_NAMES.has(n.token))
      .map((n) => `${n.file.slice(REPO_ROOT.length + 1)}: "${n.token}" — ${n.line}`);

    expect(
      unknown,
      "The skill tells a reader to type a generator name the manifest does not have.\n" +
        "Either the generator was renamed or removed, or the example is a typo:\n  " +
        unknown.join("\n  "),
    ).toEqual([]);
  });

  test("the skill's command examples name at least a few real generators", () => {
    // Otherwise the test above is vacuous: a skill that names none passes it trivially.
    const named = new Set(namesInCommands(files).map((n) => n.token));
    expect([...named].length).toBeGreaterThan(2);
  });

  test("every layer the skill names is one of the six", () => {
    // Precise about WHERE a layer is named: the first cell of a row in a table whose
    // header names `layer`. A looser "any backticked word near the word layer" sweep
    // was tried and flagged `framework`, `requires` and the English word `interface` —
    // a gate that cries wolf gets ignored, and then it gates nothing.
    const layers = new Set<string>(GENERATOR_LAYERS);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      let inLayerTable = false;
      for (const line of lines) {
        if (!line.trimStart().startsWith("|")) {
          inLayerTable = false;
          continue;
        }
        const cells = line.split("|").map((c) => c.trim());
        // A header row naming `layer` in its first cell opens the table.
        if (/^`?layers?`?$/i.test(cells[1] ?? "")) {
          inLayerTable = true;
          continue;
        }
        if (!inLayerTable) continue;
        const first = cells[1] ?? "";
        if (/^-+$/.test(first) || first === "") continue;   // the separator row
        const m = /^`([a-z][a-z-]*)`$/.exec(first);
        if (m === null) continue;
        if (layers.has(m[1]!)) continue;
        offenders.push(`${file.slice(REPO_ROOT.length + 1)}: \`${m[1]}\` — ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `A layer token that is not one of the six (${[...layers].join(", ")}):\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  test("every library token the skill tells a reader to configure is real", () => {
    // STRUCTURAL, like the two checks above: a token inside a `libraries` ARRAY, which
    // is a config value a reader copies, not prose. The same rule the layer check
    // follows — a sweep over backticked words near the word "library" would flag
    // ordinary English and then get ignored.
    const tokens = new Set(knownLibraryTokens());
    const offenders: string[] = [];
    for (const file of [...files, ...markdownFiles(AUTHORING_ROOT)]) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = /"?libraries"?\s*:\s*\[([^\]]*)\]/.exec(line);
        if (m === null) continue;
        for (const raw of m[1]!.split(",")) {
          const token = raw.trim().replace(/^["'`]|["'`]$/g, "");
          if (token === "" || tokens.has(token)) continue;
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}: "${token}" — ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `A \`libraries\` example naming a token this build does not ship ` +
        `(${[...tokens].join(", ")}):\n  ` + offenders.join("\n  "),
    ).toEqual([]);
  });

  test("the library step is actually in both skills", () => {
    // The inverse: the check above passes trivially on prose that mentions no library.
    // FR-043 §4 puts the step in the codegen procedure AND its mirror where authoring
    // teaches declaring an entity, so both are asserted.
    for (const root of [SKILL_ROOT, AUTHORING_ROOT]) {
      const prose = markdownFiles(root).map((f) => readFileSync(f, "utf8")).join("\n");
      expect(prose, `${root} teaches the library rows`).toContain('kind: "library"');
    }
  });

  test("the skill actually documents the six layers", () => {
    // The inverse of the test above, which passes trivially on a skill that mentions no
    // layer at all. The selection procedure rests on grouping BY layer, so the words
    // have to be there.
    const prose = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const layer of GENERATOR_LAYERS) {
      expect(prose, `the skill names the "${layer}" layer`).toContain(`\`${layer}\``);
    }
  });
});
