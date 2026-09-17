// oracle-cli.ts <project-dir> <postgres-url> [--naming snake_case|literal|kebab-case]
//
// Ask the independent oracle (independent-oracle.ts) of a real project and a real database:
// does every FK and column the project's metadata declares exist in that database? The
// metadata is loaded the way the `meta` CLI loads it (`loadMemory`: declared sources plus
// opted-in libraries); the answer comes from pg_catalog, never from migrate-ts.
//
// An adopter's estate runs this against its release-candidate database (the G3d run).
// Exit 0 when nothing declared is missing, 1 when something is, 2 on bad usage. FKs the
// database has and the metadata does not declare are reported but do not fail the run:
// a hand-written constraint outside the model is the adopter's business.

import { resolve } from "node:path";
import type { ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  actualColumns, actualForeignKeys, expectedColumns, expectedForeignKeys, fkKey, missingColumns,
} from "./independent-oracle.ts";

const USAGE = "usage: oracle-cli.ts <project-dir> <postgres-url> [--naming snake_case|literal|kebab-case]";
const NAMING_STRATEGIES: readonly ColumnNamingStrategy[] = ["snake_case", "literal", "kebab-case"];

const args = process.argv.slice(2);
const namingAt = args.indexOf("--naming");
const namingArg = namingAt >= 0 ? args.splice(namingAt, 2)[1] : "snake_case";
// Refuse an unknown strategy: the naming helpers would turn every column name into
// `undefined`, and a release gate reporting a flood of bogus misses — or none — is worse
// than one that stops.
const naming = NAMING_STRATEGIES.find((s) => s === namingArg);
const [projectDir, dbUrl] = args;
if (naming === undefined || projectDir === undefined || dbUrl === undefined) {
  console.error(naming === undefined ? `unknown --naming "${namingArg}"\n${USAGE}` : USAGE);
  process.exit(2);
}

const root = await loadMemory(resolve(projectDir));
const expected = expectedForeignKeys(root, naming).map(fkKey);
const actual = (await actualForeignKeys(dbUrl)).map(fkKey);
const missingFks = expected.filter((k) => !actual.includes(k));
const undeclaredFks = actual.filter((k) => !expected.includes(k));
const missingCols = missingColumns(expectedColumns(root, naming), await actualColumns(dbUrl));

console.log(`oracle: ${expected.length} declared FKs, ${actual.length} in the database`);
for (const k of missingFks) console.log(`  MISSING FK      ${k}`);
for (const c of missingCols) console.log(`  MISSING COLUMN  ${c}`);
for (const k of undeclaredFks) console.log(`  undeclared FK   ${k} (not in the metadata; not a failure)`);
if (missingFks.length + missingCols.length > 0) process.exit(1);
console.log("oracle: every declared FK and column is present");
