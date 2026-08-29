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
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/index.js";
import { collectAddressedRequirements } from "../server/typescript/packages/cli/src/lib/requirement-check.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MANIFEST = join(REPO_ROOT, "fixtures/registry-conformance/expected-registry.json");
const LEVEL_SUBTYPE = 4;

/** Placeholder the gates must reject, so a scaffold cannot be mistaken for a decision. */
const TODO = "TODO — write this by hand. See the requirement that asked for this type.";

interface Args { apply: boolean; ledgerDir: string; specDir: string }

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const rest = argv.filter((a) => a !== "--apply");
  return {
    apply,
    ledgerDir: rest[0] ?? join(REPO_ROOT, "metaobjects"),
    specDir: rest[1] ?? join(REPO_ROOT, "spec/metamodel"),
  };
}

/** Every `type.subType` already registered anywhere, and the closed type axis. */
function known(specDir: string): { keys: Set<string>; types: string[] } {
  const keys = new Set<string>();
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    types: { type: string; subType: string }[];
  };
  for (const t of manifest.types) keys.add(`${t.type}.${t.subType}`);
  for (const f of readdirSync(specDir).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(specDir, f), "utf8")) as {
      types?: { type?: string; subType: string }[];
    };
    for (const t of m.types ?? []) keys.add(`${t.type ?? f.replace(/\.json$/, "")}.${t.subType}`);
  }
  const types = [...new Set([...keys].map((k) => k.split(".")[0]!))].sort((a, b) => b.length - a.length);
  return { keys, types };
}

function splitName(name: string, types: string[]): string | undefined {
  for (const t of types) {
    if (!name.startsWith(t) || name.length === t.length) continue;
    const rest = name.slice(t.length);
    if (rest[0] !== rest[0]?.toUpperCase()) continue;
    return `${t}.${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  return undefined;
}

async function main(): Promise<number> {
  const { apply, ledgerDir, specDir } = parseArgs(process.argv.slice(2));
  const { keys, types } = known(specDir);

  const { root, errors } = await MetaDataLoader.fromDirectory(ledgerDir, { strict: true });
  if (errors.length > 0 || root === undefined) {
    console.error("scaffold-metamodel: the ledger does not load; fix it before scaffolding from it.\n");
    for (const e of errors) console.error(`  ${e.code ?? ""} ${e.message}`);
    return 1;
  }

  // A requirement naming vocabulary nothing registers is the SIGNAL, not an error.
  const wanted: { key: string; path: string; title: string }[] = [];
  for (const { node, path } of collectAddressedRequirements(root)) {
    if (node.level() !== LEVEL_SUBTYPE) continue;
    const key = splitName(node.name, types);
    if (key === undefined) {
      console.error(
        `scaffold-metamodel: '${path}' names '${node.name}', which does not split into ` +
        `<type><SubType> against any known type. Scaffolding cannot guess the type axis.\n`,
      );
      return 1;
    }
    if (!keys.has(key)) wanted.push({ key, path, title: node.title ?? node.name });
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
    const doc = JSON.parse(readFileSync(file, "utf8")) as { types: unknown[] };
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
      doc.types.push(stub);
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    }
  }

  if (!apply) {
    console.log(`\nscaffold-metamodel: ${wanted.length} stub(s) to write. Re-run with --apply.`);
    return 0;
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
