// server/typescript/packages/cli/src/lib/gen-collection.ts
//
// Where a TypeScript package's codegen config lives and which collection it generates from.
// A leaf module, importing node builtins and the sdk's collection resolver only, because the
// `meta gen` skip check (ADR-0062) answers these two questions before anything heavier loads.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveCollection, type Collection } from "@metaobjectsdev/sdk/collection";

export const GEN_CONFIG_FILE = "metaobjects.config.ts";

/**
 * The directory whose `metaobjects.config.ts` governs a run started in `startDir` —
 * the nearest ancestor carrying that file, `fallback` when there is none.
 *
 * This is a SECOND walk, deliberately separate from `resolveCollection`'s. The two
 * files answer different questions and design §4.6 already says so: `.metaobjects/
 * config.json` declares where metadata comes from — port-neutral, read by all five
 * CLIs, and reasonably repo-global in a polyglot monorepo — while
 * `metaobjects.config.ts` declares how THIS TypeScript package generates code. Reading
 * the second from the directory that carried the first (#326) meant a Maven- or
 * pip-rooted repo with a JS app underneath could not run `meta gen` at all: the
 * collection resolved to the repo root, and the app's config, sitting in the very
 * directory the command was invoked from, was never looked at.
 *
 * Nearest wins, which is what keeps the opposite arm — the divergence commit
 * 0c8fd136e fixed — closed: a run from a subdirectory that declares NO config of its
 * own walks up to the project root's, exactly as before, rather than silently
 * defaulting `columnNamingStrategy` and emitting a migration that renames every
 * column. When the two files sit together, as they do in every `meta init` project,
 * this walk and the collection walk return the same directory by construction.
 *
 * The `fallback` is the collection's directory, so a project with no
 * `metaobjects.config.ts` anywhere keeps today's diagnostics unchanged: this walk can
 * only ever move the answer CLOSER to the invocation, never further away.
 *
 * Boundaries mirror `discoverCollectionRoot` (sdk `discovery.ts`): the marker is
 * checked before `.git`, so a repo-root project sharing its directory with `.git` is
 * still reachable from any subdirectory, and the walk stops there so a monorepo can
 * never adopt a parent checkout's codegen config.
 */
export function resolveGenConfigDir(startDir: string, fallback: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, GEN_CONFIG_FILE))) return dir;
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

/**
 * The collection a TypeScript package GENERATES FROM (#340).
 *
 * #326/#327 established that the two config files answer different questions, and gave
 * `metaobjects.config.ts` its own walk. This is the remaining half of the same split:
 * a sub-project whose TS config sits below the collection root was still LOADING the
 * ancestor's whole source set, so its `src/generated` absorbed metadata belonging to
 * unrelated parts of the repository — one adopter's web app went from 376 files to 831,
 * the surplus being another module's server-side prompt payload DTOs. It fails OPEN
 * (`tsc` passes, tests pass), so the only symptom is a directory that quietly doubled.
 *
 * The rule: an ancestor `.metaobjects/config.json` is the DEFAULT for a package that
 * declares no sources of its own, never an ADDITION to one that does. So when the TS
 * config sits somewhere the collection did not, that directory is re-resolved as a
 * collection in its own right, and it wins if it actually resolves any metadata.
 *
 * It can only ever NARROW, and only in a shape that could not have worked before:
 *   - the two directories coincide (every `meta init` project, and every run from a
 *     project root) — returns the original, untouched, without a second resolve;
 *   - the sub-project declares no sources — the pinned resolve throws
 *     `ERR_SOURCE_UNRESOLVED` or comes back empty, and the ancestor stands, so a
 *     package that genuinely lives off an ancestor tree keeps working;
 *   - the sub-project has its own metadata — it generates from exactly that, which is
 *     what it did before source resolution learned to walk upward.
 *
 * Deliberately NOT applied to `.metaobjects/` STATE. Migrations, snapshots and the
 * operational block stay keyed on the discovered collection's directory (#326 settled
 * that); this narrows what is LOADED, and nothing about where state lives.
 */
export async function resolveGenCollection(
  collection: Collection,
  genConfigDir: string,
): Promise<Collection> {
  if (resolve(genConfigDir) === resolve(collection.configDir)) return collection;
  try {
    const pinned = await resolveCollection(genConfigDir, { explicitDir: genConfigDir });
    return pinned.files.length > 0 ? pinned : collection;
  } catch {
    // The sub-project declares nothing resolvable of its own — inherit, exactly as a
    // package with no config always has.
    return collection;
  }
}

