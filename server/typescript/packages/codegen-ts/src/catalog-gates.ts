// The post-selection audits `meta gen` runs over the wired suite.
//
// Codegen is opt-in, so the selection is the adopter's (increasingly their agent's).
// That makes `meta gen` the place the selection is CHECKED — not by refusing it, but by
// naming the ways a legal selection still surprises you:
//
//   1. a generator whose output imports a module nothing in the run emits;
//   2. two `api`-layer generators bringing two different HTTP frameworks;
//   3. (FR-043) a library opted into whose implied generator is not wired, or a
//      generator wired whose library is not opted into — the two halves of one choice.
//
// Both are WARNINGS, self-extinguishing, never a build failure. An adopter may
// legitimately have hand-written the other half, and serving Node and edge from one
// model is a real thing people do. Following the house rule: a gate that cries wolf
// gets deleted, and a gate nobody can satisfy is worse than no gate.

import type { Generator } from "./generator.js";
import type { GeneratorRegistryEntry } from "./generator-registry.js";

/**
 * Map a CONSTRUCTED generator back to its catalog stable name.
 *
 * These are two different names and conflating them is the trap here: the catalog key
 * is `routes` / `grid-hook`, while the object a factory returns calls itself
 * `routes-file` / `tanstack-grid-hook`. A gate keyed on `g.name` therefore matches
 * nothing at all — silently, since a name the catalog does not know is legitimately
 * skipped as somebody's own generator.
 *
 * DERIVED by constructing every catalog factory and reading the name back, not kept as
 * a table: a table would be a third spelling to maintain, and the failure mode of it
 * going stale is exactly the silent no-op above. The factories are trivial (that is a
 * registry invariant `--list` already depends on), and the result is memoized per
 * catalog object.
 *
 * An implementation name produced by two entries is dropped rather than guessed at.
 */
const STABLE_NAME_CACHE = new WeakMap<object, ReadonlyMap<string, string>>();

export function stableNameIndex(
  catalog: Record<string, GeneratorRegistryEntry>,
): ReadonlyMap<string, string> {
  const cached = STABLE_NAME_CACHE.get(catalog);
  if (cached !== undefined) return cached;

  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [stable, entry] of Object.entries(catalog)) {
    let implName: string;
    try {
      implName = entry.factory().name;
    } catch {
      continue; // a factory that cannot construct contributes nothing
    }
    if (index.has(implName) && index.get(implName) !== stable) ambiguous.add(implName);
    index.set(implName, stable);
    // The stable name maps to itself too, so a generator that already calls itself by
    // its stable name (and an ejected copy that renamed itself to one) still resolves.
    if (!index.has(stable)) index.set(stable, stable);
  }
  for (const name of ambiguous) index.delete(name);

  STABLE_NAME_CACHE.set(catalog, index);
  return index;
}

/**
 * Warn for each wired generator whose `requires` are not also wired.
 *
 * A generator whose name resolves to no catalog entry is an owned or third-party one
 * with nothing declared, and is skipped in silence — there is no declaration to check
 * it against.
 */
export function warnUnsatisfiedRequires(
  generators: readonly Generator[],
  catalog: Record<string, GeneratorRegistryEntry>,
  warn: (message: string) => void,
): void {
  const index = stableNameIndex(catalog);
  const stableOf = (g: Generator): string | undefined => index.get(g.name);
  const wired = new Set(generators.map(stableOf).filter((n): n is string => n !== undefined));

  for (const g of generators) {
    const stable = stableOf(g);
    if (stable === undefined) continue;
    const entry = catalog[stable];
    if (entry?.requires === undefined) continue;
    const missing = entry.requires.filter((dep) => !wired.has(dep));
    if (missing.length === 0) continue;

    const list = missing.map((m) => `"${m}"`).join(", ");
    warn(
      `"${stable}" is wired but ${list} ${missing.length === 1 ? "is" : "are"} not. ` +
        `The code "${stable}" emits imports modules ${list} would have emitted, so ` +
        `tsc will report an unresolved import. Wire ${missing.length === 1 ? "it" : "them"} ` +
        `(\`meta eject ${missing.join(" ")}\` copies the reference generator${missing.length === 1 ? "" : "s"}), ` +
        `or keep your own hand-written module${missing.length === 1 ? "" : "s"} at ${missing.length === 1 ? "that path" : "those paths"}.`,
    );
  }
}

/**
 * Warn when two wired `api`-layer generators declare DIFFERENT frameworks.
 *
 * Verified before it was written: `routes` emits `<Entity>.routes.ts` and `routes-hono`
 * emits `<Entity>.routes.hono.ts`. Different paths — so wiring both does not trip the
 * runner's conflicting-output-path error, does not fail `tsc`, and silently produces two
 * complete HTTP surfaces over the same entities. Worth saying; not worth refusing.
 *
 * **`api` only, and there is deliberately no general per-layer rule.** The `client`
 * layer disproves one: `@metaobjectsdev/tanstack` declares `react` as a peer, so
 * `form` (react) + `hooks`/`grid` (tanstack) is the documented, normal composition. An
 * earlier draft of the design carried "at most one framework per api and per client
 * layer"; that rule would have forbidden the single most common client selection.
 */
export function warnMixedApiFrameworks(
  generators: readonly Generator[],
  catalog: Record<string, GeneratorRegistryEntry>,
  warn: (message: string) => void,
): void {
  const index = stableNameIndex(catalog);
  const byFramework = new Map<string, string[]>();
  for (const g of generators) {
    const stable = index.get(g.name);
    if (stable === undefined) continue;
    const entry = catalog[stable];
    if (entry?.layer !== "api" || entry.framework === undefined) continue;
    const names = byFramework.get(entry.framework) ?? [];
    names.push(stable);
    byFramework.set(entry.framework, names);
  }
  if (byFramework.size < 2) return;

  const described = [...byFramework.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fw, names]) => `${names.sort().map((n) => `"${n}"`).join(" + ")} (${fw})`)
    .join(" and ");

  warn(
    `two api-layer frameworks are wired — ${described}. They emit to DIFFERENT paths, ` +
      "so nothing conflicts and nothing fails; this run produces two complete HTTP " +
      "surfaces over the same entities. That is legitimate when you are migrating " +
      "between them or serving Node and edge from one model — otherwise wire one.",
  );
}

/**
 * Warn on the two halves of a library/generator selection that do not agree.
 *
 * A library ships metadata; a generator that keys on that metadata is a separate
 * choice, and FR-043 §6 deliberately wires neither for you. What it does instead is
 * refuse to let either half be silently half-done:
 *
 *   - **opted in, not wired** — the design is in your model and the code it implies is
 *     not being generated.
 *   - **wired, not opted in** — the generator's anchor is a node only that library
 *     declares, so it will match nothing and emit zero files. Without this line that is
 *     indistinguishable from "my model has no trace entities yet".
 *
 * Both self-extinguish: wire it, or opt in, or remove one. Neither ever fails a build —
 * an adopter who ejected the library and owns the metadata is in a legitimate state
 * this cannot see, and a gate that cries wolf gets switched off.
 *
 * `optedIn` is the project's selection TOKENS (`["ai", "ai/db"]`); a layer token names
 * the same library as its bare form.
 */
export function warnLibrarySelectionMismatch(
  generators: readonly Generator[],
  catalog: Record<string, GeneratorRegistryEntry>,
  manifests: Readonly<Record<string, { generators?: ReadonlyArray<{ name: string }> }>>,
  optedIn: readonly string[],
  warn: (message: string) => void,
): void {
  const index = stableNameIndex(catalog);
  const wired = new Set(
    generators.map((g) => index.get(g.name)).filter((n): n is string => n !== undefined),
  );
  const selected = new Set(optedIn.map((t) => t.split("/")[0]!));

  for (const [library, manifest] of Object.entries(manifests)) {
    const implied = (manifest.generators ?? []).map((g) => g.name);
    if (implied.length === 0) continue;

    if (selected.has(library)) {
      const notWired = implied.filter((n) => !wired.has(n));
      if (notWired.length > 0) {
        warn(
          `library "${library}" is opted in and implies ${notWired.map((n) => `"${n}"`).join(", ")}, ` +
            `which ${notWired.length === 1 ? "is" : "are"} not wired. The design is in your model; ` +
            `the code it implies is not being generated. Wire it, or ignore this if you are ` +
            `taking the metadata alone.`,
        );
      }
      continue;
    }

    // Not opted in: name any of its generators that ARE wired. Checked per library
    // rather than per generator so a name two libraries imply is not reported twice
    // when one of them is selected.
    const orphaned = implied.filter(
      (n) => wired.has(n) && !impliedByAnySelected(n, manifests, selected),
    );
    if (orphaned.length > 0) {
      warn(
        `${orphaned.map((n) => `"${n}"`).join(", ")} ${orphaned.length === 1 ? "is" : "are"} wired, ` +
          `but library "${library}" — which declares the node ${orphaned.length === 1 ? "it keys" : "they key"} ` +
          `on — is not opted in, so ${orphaned.length === 1 ? "it will" : "they will"} match nothing and emit ` +
          `no files. Add "${library}" to \`libraries\` in .metaobjects/config.json, or unwire ` +
          `${orphaned.length === 1 ? "it" : "them"}.`,
      );
    }
  }
}

function impliedByAnySelected(
  generator: string,
  manifests: Readonly<Record<string, { generators?: ReadonlyArray<{ name: string }> }>>,
  selected: ReadonlySet<string>,
): boolean {
  return [...selected].some((lib) =>
    (manifests[lib]?.generators ?? []).some((g) => g.name === generator),
  );
}
