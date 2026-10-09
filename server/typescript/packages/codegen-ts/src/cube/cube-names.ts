// FR-044 Plan 4, Table G — the names Cube can take, and the collisions it cannot. A cube is
// named after its entity and a member after its dimension, measure or segment, so a report
// field and its Cube member are one name. A name Cube refuses is an error, never a rename.

import {
  CubeModelError,
  ERR_CUBE_INVALID_NAME,
  ERR_CUBE_MEMBER_COLLISION,
  ERR_CUBE_NAME_COLLISION,
} from "./cube-errors.js";

/** Cube compiles a model through Python; these names are refused as cube or member names. */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "from", "class", "in", "is", "not", "and", "or", "if", "else", "for", "while", "with", "as", "def",
  "return", "yield", "import", "pass", "global", "nonlocal", "lambda", "del", "assert", "break",
  "continue", "try", "except", "finally", "raise", "async", "await", "True", "False", "None", "elif",
]);

const CUBE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const NAME_RULE =
  "Cube names start with a letter, hold only letters, digits and _, and are not a Python keyword";

/** Why Cube refuses `name`, or undefined when it can take it. */
function nameProblem(name: string): string | undefined {
  if (!CUBE_NAME.test(name)) {
    return name === "" ? "it is empty" : "it does not start with a letter or holds a character other than a letter, digit or _";
  }
  if (PYTHON_KEYWORDS.has(name)) return "it is a Python keyword";
  return undefined;
}

/** Throw ERR_CUBE_INVALID_NAME when Cube cannot take `name`. `what` names the node. */
export function assertCubeName(name: string, what: string): void {
  const problem = nameProblem(name);
  if (problem === undefined) return;
  throw new CubeModelError(
    ERR_CUBE_INVALID_NAME,
    `${what} is named '${name}', which Cube cannot take: ${problem}. ${NAME_RULE}. ` +
      `Rename it in the model; the exporter never renames, because a Cube member and its report field share one name.`,
  );
}

/**
 * One cube's member namespace. Cube's dimensions, measures and segments share it, and the
 * members the exporter adds (primary-key and reached-column dimensions) are in it too.
 */
export class MemberNamespace {
  private readonly owners = new Map<string, string>();

  constructor(private readonly cube: string) {}

  /** Claim `name` for the member `what` describes; a second claim is a collision naming both. */
  add(name: string, what: string): void {
    assertCubeName(name, what);
    const prior = this.owners.get(name);
    if (prior !== undefined) {
      throw new CubeModelError(
        ERR_CUBE_MEMBER_COLLISION,
        `cube '${this.cube}': ${prior} and ${what} are both named '${name}', and a cube's dimensions, ` +
          `measures and segments share one namespace. Rename one of them in the model.`,
      );
    }
    this.owners.set(name, what);
  }

  has(name: string): boolean {
    return this.owners.has(name);
  }
}

/** Every cube name valid and distinct. `cubes` pairs each name with what it was made from. */
export function assertCubeNames(cubes: readonly { readonly name: string; readonly what: string }[]): void {
  const seen = new Map<string, string>();
  for (const { name, what } of cubes) {
    assertCubeName(name, what);
    const prior = seen.get(name);
    if (prior !== undefined) {
      throw new CubeModelError(
        ERR_CUBE_NAME_COLLISION,
        `${prior} and ${what} would both be cube '${name}'. A cube is named after its entity and the name ` +
          `is kept as written, so narrow the generator's filter to select only one of them, or rename one.`,
      );
    }
    seen.set(name, what);
  }
}
