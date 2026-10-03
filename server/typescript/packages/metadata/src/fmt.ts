// meta fmt (#304) — format a single metadata FILE's own content.
//
// The canonical serializer (serializer-json.ts) already produces deterministic,
// cross-port byte-identical JSON for a loaded MetaData node — that is what the
// conformance corpora byte-match against. `meta fmt` surfaces it as a per-file
// formatter: each file is parsed STANDALONE (never merged with its siblings)
// and re-emitted via `canonicalSerialize`, so the output is strictly that
// file's own declared content — own-mode, declared-here layer only (ADR-0039).
//
// Two properties fall out of parsing a file standalone rather than loading the
// whole project and slicing the merged tree:
//
//   - A cross-file `extends` ref (the common `extends: "BaseEntity"` pattern,
//     where the base lives in another file) is never an error here: super
//     resolution is deferred and this module never runs the second pass that
//     would fail an UNRESOLVED ref. Own-mode serialization only needs the raw
//     `superRef` string, never the resolved target.
//   - A file declaring `overlay: true` ANYWHERE in its tree is never
//     formatted — reported as `overlay: true` so a caller can leave it
//     untouched rather than guess at a merge. This is true REGARDLESS of
//     whether a same-(type,name) base exists elsewhere in the file: a
//     formatter must never change STRUCTURE, and buildTree's ordinary
//     find-or-reuse behavior would happily fold a plain declaration and a
//     same-file `overlay: true` redeclaration into one merged node —
//     silently dropping the overlay marker from the output. Checking the
//     raw document for `overlay: true` BEFORE buildTree ever runs (see
//     `hasOverlayDeclaration` below) catches that case too, not just the
//     no-local-target one buildTree's own ERR_OVERLAY_NO_TARGET reports. A
//     MIXED file (plain + overlay declarations together, anywhere) is
//     reported as `overlay: true` too — fmt does not partially format a file.
import { buildTree } from "./parser-core.js";
import { canonicalSerialize } from "./serializer-json.js";
import type { TypeRegistry } from "./registry.js";
import { JSON_KEY_SCHEMA, RESERVED_KEY_CHILDREN, RESERVED_KEY_OVERLAY } from "./shared/structural.js";

export interface FormatFileOptions {
  /** The registry this project loads against — core providers plus any the
   *  project's own config registers, so a custom attr never false-positives. */
  readonly registry: TypeRegistry;
  /** ADR-0023 strict-attr loading. Default false (lenient), matching `meta gen`
   *  rather than `meta verify` — fmt reformats whatever already loads; an
   *  unrecognized `@attr` is `verify`'s job to flag, not fmt's to refuse on. */
  readonly strict?: boolean;
  /** The source id this file's nodes record provenance under — normally the
   *  same id the full project load would use (basename, or a dependency's
   *  `dep:<name>/<artifact>` id). Used only for error messages here. */
  readonly sourceId: string;
}

export type FormatFileResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly overlay: boolean; readonly message: string };

/** The code `buildTree`'s overlay drain raises when a queued `overlay: true`
 *  declaration finds no same-(type,name) base in the tree being built — here,
 *  always because the base lives in a file this standalone parse never sees.
 *  Kept as a defensive second signal; `hasOverlayDeclaration` below is what
 *  actually decides the common case (a local base DOES exist). */
const OVERLAY_NO_TARGET_CODE = "ERR_OVERLAY_NO_TARGET";

/**
 * Whether `doc` (an already-`JSON.parse`d canonical document) declares an
 * `overlay: true` node anywhere in its tree — the top-level declaration
 * itself, or any descendant reached by walking `children` arrays.
 *
 * A purely STRUCTURAL check, independent of the registry and run BEFORE
 * `buildTree`: fmt must never attempt a same-file merge of a plain
 * declaration and an `overlay: true` redeclaration of the same (type, name)
 * — buildTree's ordinary find-or-reuse behavior would silently fold the two
 * into one node, dropping the overlay marker, which is exactly the
 * "formatter changes structure" outcome `meta fmt` must never produce. This
 * catches that case (a local base exists) as well as the no-target one
 * buildTree's own `ERR_OVERLAY_NO_TARGET` reports — the two are the same
 * refusal from a caller's point of view: this file is not fmt's to format.
 */
function hasOverlayDeclaration(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  for (const [key, body] of Object.entries(doc as Record<string, unknown>)) {
    if (key === JSON_KEY_SCHEMA) continue;
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    if (bodyHasOverlay(body as Record<string, unknown>)) return true;
  }
  return false;
}

function bodyHasOverlay(body: Record<string, unknown>): boolean {
  const children = body[RESERVED_KEY_CHILDREN];
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
    for (const childBody of Object.values(child as Record<string, unknown>)) {
      if (typeof childBody !== "object" || childBody === null || Array.isArray(childBody)) continue;
      const cb = childBody as Record<string, unknown>;
      if (cb[RESERVED_KEY_OVERLAY] === true) return true;
      if (bodyHasOverlay(cb)) return true;
    }
  }
  return false;
}

/**
 * Format one file's own content into canonical JSON. Parses `content`
 * standalone (no `intoRoot` — never merged with any other file) and, on a
 * clean parse, returns the canonical serialization of the resulting file
 * root. Never throws: a JSON syntax error, a structural parse error, or any
 * `overlay: true` declaration all come back as `{ ok: false }`.
 */
export function formatMetadataFile(content: string, opts: FormatFileOptions): FormatFileResult {
  // Strip a UTF-8 BOM before parsing (mirrors parseJson's own front-end,
  // parser-json.ts) — a BOM-prefixed file is otherwise a flat JSON.parse
  // syntax error, and Java-authored files often carry one.
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    return {
      ok: false,
      overlay: false,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (hasOverlayDeclaration(parsed)) {
    return {
      ok: false,
      overlay: true,
      message: "this file declares an overlay fmt cannot resolve standalone",
    };
  }

  try {
    const result = buildTree(parsed, {
      registry: opts.registry,
      strict: opts.strict ?? false,
      sourceName: opts.sourceId,
      // Never resolved here — see module header. A cross-file `extends` must
      // not become an error just because this file is formatted in isolation.
      deferSuperResolution: true,
    });

    if (result.errors.length > 0) {
      const overlay = result.errors.some((e) => e.code === OVERLAY_NO_TARGET_CODE);
      return {
        ok: false,
        overlay,
        message: result.errors.map((e) => e.message).join("; "),
      };
    }

    return { ok: true, text: canonicalSerialize(result.root) };
  } catch (err) {
    return {
      ok: false,
      overlay: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
