// FR-044 Plan 4 — the cube-model generator's own errors (Tables C, E, F and G). These are
// generator errors, printed in the message; they are not loader codes and are not listed in
// fixtures/conformance/ERROR-CODES.json.

export const ERR_CUBE_UNMAPPABLE_DIMENSION = "ERR_CUBE_UNMAPPABLE_DIMENSION";
export const ERR_CUBE_UNMAPPABLE_JOIN = "ERR_CUBE_UNMAPPABLE_JOIN";
export const ERR_CUBE_UNMAPPABLE_REPORT = "ERR_CUBE_UNMAPPABLE_REPORT";
export const ERR_CUBE_AMBIGUOUS_PATH = "ERR_CUBE_AMBIGUOUS_PATH";
export const ERR_CUBE_NO_PRIMARY_KEY = "ERR_CUBE_NO_PRIMARY_KEY";
export const ERR_CUBE_INVALID_NAME = "ERR_CUBE_INVALID_NAME";
export const ERR_CUBE_MEMBER_COLLISION = "ERR_CUBE_MEMBER_COLLISION";
export const ERR_CUBE_NAME_COLLISION = "ERR_CUBE_NAME_COLLISION";
export const ERR_CUBE_UNESCAPABLE_LITERAL = "ERR_CUBE_UNESCAPABLE_LITERAL";
/** The generator's dialect is not one it writes Cube SQL for (postgres, mysql). */
export const ERR_CUBE_UNSUPPORTED_DIALECT = "ERR_CUBE_UNSUPPORTED_DIALECT";

export const CUBE_ERROR_CODES = [
  ERR_CUBE_UNMAPPABLE_DIMENSION,
  ERR_CUBE_UNMAPPABLE_JOIN,
  ERR_CUBE_UNMAPPABLE_REPORT,
  ERR_CUBE_AMBIGUOUS_PATH,
  ERR_CUBE_NO_PRIMARY_KEY,
  ERR_CUBE_INVALID_NAME,
  ERR_CUBE_MEMBER_COLLISION,
  ERR_CUBE_NAME_COLLISION,
  ERR_CUBE_UNESCAPABLE_LITERAL,
  ERR_CUBE_UNSUPPORTED_DIALECT,
] as const;
export type CubeErrorCode = (typeof CUBE_ERROR_CODES)[number];

/**
 * Something the Cube mapping cannot express (spec §3 obligation 3: lossless or an error).
 * `message` is `"<CODE>: <detail>"`; the detail names the node by its resolution key, says why
 * Cube cannot take it, and says what to change.
 */
export class CubeModelError extends Error {
  readonly code: CubeErrorCode;

  constructor(code: CubeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "CubeModelError";
    this.code = code;
  }
}
