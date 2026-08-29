// FR-040 §6.4 — the module-level client-component directive on generated CLIENT
// artifacts (forms, hooks, grid columns, grid hooks).
//
// One implementation in the shared engine rather than a string literal in each of the
// four UI generators: the directive must be the FIRST statement in the module to have
// any effect, and "prepend a line" is the kind of thing four copies get subtly
// different (a missing blank line, a single-quoted variant, or — the one that actually
// breaks — emitted after the generated header comment in one and before it in another).
//
// Why this is a config knob and not metadata, and why it defaults OFF, is on
// `MetaobjectsGenConfig.clientDirective`.

/** The directive itself. Double-quoted to match the emitted code's own quote style. */
export const CLIENT_DIRECTIVE = '"use client";';

/**
 * Prepend the client directive to a generated module body when the project asked for it.
 *
 * Placement is the whole point: a directive prologue is only honoured before any other
 * statement, and — unlike a runtime statement — it must also precede the `@generated`
 * header comment for some bundlers to see it, so this goes at absolute position 0.
 * Idempotent: a body that already opens with the directive (a hand edit preserved
 * through three-way merge, or an owned generator that adds its own) is returned
 * unchanged rather than given a second copy.
 *
 * @param body    the rendered module source.
 * @param enabled `ctx.clientDirective` — false (the default) returns `body` untouched,
 *                so output is byte-identical for every project that does not opt in.
 */
export function withClientDirective(body: string, enabled: boolean): string {
  if (!enabled) return body;
  // Tolerate either quote style when checking, so an adopter's own `'use client'`
  // is not doubled — but always EMIT the canonical form.
  if (/^\s*['"]use client['"];?/.test(body)) return body;
  return `${CLIENT_DIRECTIVE}\n\n${body}`;
}
