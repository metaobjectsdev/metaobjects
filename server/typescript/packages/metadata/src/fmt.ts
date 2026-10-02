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
//   - An `overlay: true` declaration with no base IN THIS FILE cannot be
//     resolved standalone — exactly the real authoring pattern (a separate
//     overlay file amending a base declared elsewhere). buildTree's normal
//     overlay-drain surfaces that as ERR_OVERLAY_NO_TARGET; this module reports
//     it as `overlay: true` so a caller can leave the file untouched rather
//     than guess at a merge it cannot see. A MIXED file (plain + overlay
//     declarations together) is reported as `overlay: true` too — fmt does not
//     partially format a file.
import { buildTree } from "./parser-core.js";
import { canonicalSerialize } from "./serializer-json.js";
import type { TypeRegistry } from "./registry.js";

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
 *  always because the base lives in a file this standalone parse never sees. */
const OVERLAY_NO_TARGET_CODE = "ERR_OVERLAY_NO_TARGET";

/**
 * Format one file's own content into canonical JSON. Parses `content`
 * standalone (no `intoRoot` — never merged with any other file) and, on a
 * clean parse, returns the canonical serialization of the resulting file
 * root. Never throws: a JSON syntax error, a structural parse error, or an
 * overlay with no local base all come back as `{ ok: false }`.
 */
export function formatMetadataFile(content: string, opts: FormatFileOptions): FormatFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      overlay: false,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
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
