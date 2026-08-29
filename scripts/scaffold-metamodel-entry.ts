#!/usr/bin/env bun
/**
 * Phase 3 — forward scaffolding. The requirement comes FIRST.
 *
 * The usual order is: add vocabulary, then describe it. That order is why
 * descriptions read as descriptions — they are written about something that
 * already exists, by someone who has just finished building it, and the question
 * "what must never happen" is never asked.
 *
 * This runs the other way. Author an L4 requirement naming a subtype that exists
 * nowhere yet — the promise and the counterexample, before the type — and this
 * scaffolds the `spec/metamodel/<type>.json` entry it implies. The scaffold is a
 * STUB, deliberately: it carries the coordinates, which are derivable, and refuses
 * to invent the three prose fields, which are not.
 *
 * ── Why the prose slots are left empty ──────────────────────────────────────────
 *
 * It would be one line to copy the requirement's `statement` into `description`.
 * That is exactly what must not happen. A requirement states a PROMISE ("money is
 * never handled as a fraction"); a registry description states what the thing IS
 * and how to use it. They are different sentences about the same subject, and a
 * plausible prefilled one is the one nobody rewrites. The stub therefore fails its
 * own gate until a human writes them — the same posture as a generated test stub
 * that is worthless until hand-edited.
 *
 * ── This is a deliberate, gated act ─────────────────────────────────────────────
 *
 * Writing here changes the registered vocabulary, so `expected-registry.json` moves
 * and `check-metamodel-version.mjs` demands a version bump. That is the point: new
 * vocabulary is never a side effect. Nothing runs this automatically — it is
 * `--apply` or it prints what it would do.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/index.js";
import { collectAddressedRequirements } from "../server/typescript/packages/cli/src/lib/requirement-check.js";
import {
  DEFAULT_LEDGER_DIR,
  DEFAULT_MANIFEST,
  DEFAULT_SPEC_DIR,
  LEVEL_SUBTYPE,
  participatesInVocabularyLink,
  population,
  splitName,
  typeAxis,
} from "./lib/requirement-vocabulary.js";

/** Placeholder the gates must reject, so a scaffold cannot be mistaken for a decision. */
const TODO = "TODO — write this by hand. See the requirement that asked for this type.";

interface Args { apply: boolean; ledgerDir: string; specDir: string; manifest: string }

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const rest = argv.filter((a) => a !== "--apply");
  return {
    apply,
    ledgerDir: rest[0] ?? DEFAULT_LEDGER_DIR,
    specDir: rest[1] ?? DEFAULT_SPEC_DIR,
    // Parameterised alongside specDir: pinning it to the real repo made the
    // self-test's "throwaway provider tree" not a throwaway at all — all 69 real
    // manifest rows stayed in scope, so its cases passed or failed on repository
    // state no assertion named.
    manifest: rest[2] ?? DEFAULT_MANIFEST,
  };
}


/**
 * Append one entry to a provider file's `types` array by editing TEXT, not by
 * re-serialising the document. Returns undefined when the array's end cannot be
 * located, so the caller refuses rather than guessing.
 */
function appendType(raw: string, stub: unknown): string | undefined {
  const close = raw.lastIndexOf("]");
  if (close === -1) return undefined;
  const before = raw.slice(0, close).replace(/\s+$/, "");
  const indent = "    ";
  const body = JSON.stringify(stub, null, 2)
    .split("\n")
    .map((l) => `${indent}${l}`)
    .join("\n");
  const sep = before.endsWith("[") ? "" : ",";
  return `${before}${sep}\n${body}\n  ${raw.slice(close)}`;
}

async function main(): Promise<number> {
  const { apply, ledgerDir, specDir, manifest } = parseArgs(process.argv.slice(2));
  const pop = population(specDir, manifest);
  const types = typeAxis(pop);

  const { root, errors } = await MetaDataLoader.fromDirectory(ledgerDir, { strict: true });
  if (errors.length > 0 || root === undefined) {
    console.error("scaffold-metamodel: the ledger does not load; fix it before scaffolding from it.\n");
    for (const e of errors) console.error(`  ${e.code ?? ""} ${e.message}`);
    return 1;
  }

  // A requirement naming vocabulary nothing registers is the SIGNAL, not an error.
  const wanted: { key: string; path: string; title: string }[] = [];
  for (const { node, path } of collectAddressedRequirements(root)) {
    // Architectural requirements name no subtype — see participatesInVocabularyLink.
    if (!participatesInVocabularyLink(node) || node.level() !== LEVEL_SUBTYPE) continue;
    const key = splitName(node.name, types);
    if (key === undefined) {
      console.error(
        `scaffold-metamodel: '${path}' names '${node.name}', which does not split into ` +
        `<type><SubType> against any known type. Scaffolding cannot guess the type axis.\n`,
      );
      return 1;
    }
    // `attr()` RESOLVES and is the accessor that exists — `node.title` is not a
    // property of MetaData at all, so the old read was always undefined and this
    // silently reported the node's NAME where it meant the authored title.
    const title = node.attr("title");
    if (!pop.has(key)) wanted.push({ key, path, title: typeof title === "string" ? title : node.name });
  }

  if (wanted.length === 0) {
    console.log("scaffold-metamodel: nothing to scaffold — every authored requirement names registered vocabulary.");
    return 0;
  }

  for (const { key, path, title } of wanted) {
    const [type, subType] = key.split(".") as [string, string];
    const file = join(specDir, `${type}.json`);
    if (!existsSync(file)) {
      console.error(
        `scaffold-metamodel: '${key}' needs spec/metamodel/${type}.json, which does not exist.\n` +
        `A whole new TYPE is a bigger decision than a new subtype — ADR-0037's step 2 — so it is\n` +
        `not scaffolded. Create the provider file deliberately, then re-run.\n`,
      );
      return 1;
    }
    const raw = readFileSync(file, "utf8");
    const doc = JSON.parse(raw) as { types?: unknown };
    if (!Array.isArray(doc.types)) {
      console.error(
        `scaffold-metamodel: spec/metamodel/${type}.json has no 'types' array to append to.\n` +
        `Refusing rather than creating one — the file shape is a provider contract.\n`,
      );
      return 1;
    }
    const stub = {
      type,
      subType,
      extendsBase: true,
      description: TODO,
      whenToUse: TODO,
      rules: TODO,
      children: [] as unknown[],
    };
    console.log(`  ${apply ? "write" : "would write"}  ${key}  ← ${path}  (${title})`);
    if (apply) {
      // APPENDED textually, never re-serialised. `JSON.stringify(JSON.parse(x), null, 2)`
      // is not a round trip for 12 of the 18 shipped provider files — it reflows key
      // spacing, unicode escapes and wrapping — so writing the whole document back
      // would bury the one stub under a whole-file diff, in artifacts whose prose is
      // byte-gated across five ports, immediately before check-metamodel-version
      // demands a bump for it.
      const written = appendType(raw, stub);
      if (written === undefined) {
        console.error(
          `scaffold-metamodel: could not locate the end of the 'types' array in ` +
          `spec/metamodel/${type}.json to append to. Refusing rather than rewriting the file.\n`,
        );
        return 1;
      }
      writeFileSync(file, written);
    }
  }

  if (!apply) {
    // NON-ZERO deliberately. ci-local.sh runs this bare as a gate whose claim is that
    // nothing needs scaffolding; returning 0 here made that claim unfalsifiable — the
    // lane stayed green while the tool printed the drift it had just found, and the
    // self-test pinned the zero. A proposal IS the drift: a requirement is naming
    // vocabulary that exists nowhere.
    console.error(
      `\nscaffold-metamodel: ${wanted.length} requirement(s) name vocabulary that exists nowhere.\n` +
      `Write the entries with --apply, then fill in the prose by hand.\n`,
    );
    return 1;
  }
  console.log(
    `\nscaffold-metamodel: ${wanted.length} stub(s) written with placeholder prose.\n` +
    `NEXT, BY HAND: replace every '${TODO.slice(0, 4)}…' — description (what it IS), whenToUse,\n` +
    `and rules. Then bump the metamodel version:\n` +
    `  node scripts/check-metamodel-version.mjs --set <version>\n` +
    `and register the subtype in all five ports. The registry gates will name what is missing.`,
  );
  return 0;
}

process.exit(await main());
