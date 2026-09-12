// server/typescript/packages/metadata/src/scope.ts
//
// FR-023 §4.3 — the scope-pattern grammar. Moved here from
// `@metaobjectsdev/sdk` so `codegen-ts`'s publisher generator
// (`sharedModelFile()`) can select its exports with the same patterns
// without taking a dependency on sdk. `@metaobjectsdev/sdk` re-exports
// `compileScope` / `matchesScope` / `Scope` / `CompiledScope` from here
// unchanged, so existing importers of the scope API from sdk keep working.
//
// A pure, no-I/O module deciding whether a fully-qualified node name falls
// inside a consumer's declared `include`/`exclude` scope. Source resolution
// and discovery (later phase-1 tasks) build on this; a cross-language
// conformance corpus pins its semantics, so exact pattern behavior matters.
//
// Uses no `node:` imports — stays browser-safe like the rest of the root
// entry (see `test/browser-safety.test.ts`).
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { ParseError } from "./errors.js";
import { codeSource } from "./source.js";

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
  // A segment surviving the split on the two-character PACKAGE_SEPARATOR
  // ("::") can still contain a lone ":" when the pattern has an odd colon
  // run — e.g. "acme:::Order".split("::") => ["acme", ":Order"]. SEGMENT
  // ([^:]+) already excludes ":" from a well-formed segment, so a leftover
  // ":" here means the separator was malformed, not that ":" is meant
  // literally. Left unchecked, escapeLiteral treats it as a literal
  // character and compiles a regex requiring three colons in a row — which
  // no legal "::"-joined fully-qualified name can ever contain, so the
  // pattern silently matches nothing instead of failing loud.
  if (segment.includes(":")) {
    throw new ParseError(
      `scope pattern "${pattern}" has a malformed separator (an odd run of ":") — segments are joined by "::", never a single ":"`,
      { code: "ERR_SCOPE_PATTERN_INVALID", source: codeSource("compileSegment") },
    );
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
