// server/typescript/packages/sdk/src/scope.ts
//
// Phase-1 metadata-source-resolution — the scope pattern engine.
//
// A pure, no-I/O module deciding whether a fully-qualified node name falls
// inside a consumer's declared `include`/`exclude` scope. Source resolution
// and discovery (later phase-1 tasks) build on this; a cross-language
// conformance corpus pins its semantics, so exact pattern behavior matters.

// NOTE: PACKAGE_SEPARATOR is NOT re-exported from the browser-safe
// `@metaobjectsdev/metadata/constants` barrel (that barrel only re-exports
// the per-concern `*-constants.ts` modules; `PACKAGE_SEPARATOR` lives in
// `shared/structural.ts`, exported from the package root). This package
// (`@metaobjectsdev/sdk`) is server-side, not a `client/web/**` browser
// package, so importing metamodel values from the root — the same thing
// `memory.ts` and `forge-types.ts` in this package already do — is correct.
import { PACKAGE_SEPARATOR, ParseError, codeSource } from "@metaobjectsdev/metadata";

/** A consumer-side output filter over fully-qualified node names. */
export interface Scope {
  /** Absent or empty means "everything". */
  readonly include?: readonly string[];
  /** Applied after `include`. */
  readonly exclude?: readonly string[];
}

export interface CompiledScope {
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
}

/** One package segment: any run of characters containing no separator char. */
const SEGMENT = "[^:]+";
/** One or more segments, separator-joined — the `**` expansion. */
const SEGMENTS = `${SEGMENT}(?:${PACKAGE_SEPARATOR}${SEGMENT})*`;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one segment. `**` spans segments; `*` never crosses a separator. */
function compileSegment(segment: string, pattern: string): string {
  if (segment.length === 0) {
    throw new ParseError(`empty segment in scope pattern "${pattern}"`, {
      code: "ERR_SCOPE_PATTERN_INVALID",
      source: codeSource("compileSegment"),
    });
  }
  if (segment === "**") return `(?:${SEGMENTS})`;
  // `*` inside a segment matches any characters except the separator char.
  return segment.split("*").map(escapeLiteral).join("[^:]*");
}

export function compilePattern(pattern: string): RegExp {
  if (pattern.length === 0) {
    throw new ParseError(`scope pattern must not be empty`, {
      code: "ERR_SCOPE_PATTERN_INVALID",
      source: codeSource("compilePattern"),
    });
  }
  const body = pattern
    .split(PACKAGE_SEPARATOR)
    .map((segment) => compileSegment(segment, pattern))
    .join(PACKAGE_SEPARATOR);
  return new RegExp(`^${body}$`);
}

export function compileScope(scope: Scope): CompiledScope {
  return {
    include: (scope.include ?? []).map(compilePattern),
    exclude: (scope.exclude ?? []).map(compilePattern),
  };
}

/** True when `fqn` is inside the scope. An empty `include` means everything. */
export function matchesScope(fqn: string, compiled: CompiledScope): boolean {
  const included = compiled.include.length === 0 || compiled.include.some((re) => re.test(fqn));
  if (!included) return false;
  return !compiled.exclude.some((re) => re.test(fqn));
}
