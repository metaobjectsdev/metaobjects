// server/typescript/packages/cli/src/lib/overlay-lint.ts
//
// `meta verify` — the overlay AUTHORING lint (FR-023 §11.1 item 4).
//
// The parser's own merge rule (parser-core.ts, "Default: no operator →
// silently reuse existing or create new") means a top-level redeclaration of
// an existing node works TODAY whether or not it carries `overlay: true` —
// as long as the target still exists under the same (type, resolutionKey).
// That is exactly the trap: a consumer who redeclares an imported node
// without the flag gets today's silent merge for free, and gets a silent NEW
// OBJECT the day the upstream node is renamed or removed — no error, just a
// second, disconnected node under the same name. `overlay: true` turns that
// into a loud `ERR_OVERLAY_NO_TARGET` instead.
//
// This lint does not change that parser behavior (nor could it — it reads
// raw file content, never the parser's merge decisions). It tells the AUTHOR:
// every top-level (type, resolutionKey) declared in two or more of the
// collection's files where more than one declaration lacks the flag. Exactly
// one unflagged declaration is the base and is fine; every additional
// unflagged one is a finding.
//
// Advisory only, like its sibling in requirement-lint.ts: never fails
// `meta verify`, never changes load behavior. Deliberately NO severity
// constant to flip — see requirement-lint.ts's header for why that promise
// would be false here too.

import { declaredTopLevelKeys, type DeclaredTopLevelKey, type MetaDataSource } from "@metaobjectsdev/metadata";
import type { Collection } from "@metaobjectsdev/sdk";
import { relPosix } from "./rel-posix.js";
import type { Diagnostic } from "./requirement-check.js";

export const WARN_OVERLAY_IMPLICIT = "WARN_OVERLAY_IMPLICIT";

/**
 * Resolve one collection file path to the `MetaDataSource` `lintOverlays`
 * reads it through. Injected so the lint never touches the filesystem
 * directly: the production wiring in `verify.ts` backs this with
 * `FileSource` (from `@metaobjectsdev/metadata/core`); a test can supply an
 * in-memory source instead.
 */
export type ReadSource = (path: string) => MetaDataSource;

function warn(code: string, message: string): Diagnostic {
  return { severity: "warn", code, message };
}

/** One file's declaration of a given (type, resolutionKey). */
interface Declaration {
  readonly file: string;
  readonly overlay: boolean;
}

/**
 * Lint the collection's files for unflagged cross-file redeclarations.
 *
 * Reads every file in `collection.files` — dependency artifacts first, since
 * `Collection.files` already orders them that way and they are the BASES a
 * consumer's own declarations amend — and structurally scans each with
 * {@link declaredTopLevelKeys} (never the loaded/merged model: the merged
 * tree has already lost which FILE contributed which declaration).
 *
 * Groups by (type, resolutionKey) — mirroring the parser's own merge lookup,
 * which matches on type AND resolutionKey (parser-core.ts) — and reports
 * every unflagged declaration after the first one for a key with 2+
 * declarations. The first unflagged declaration is the base.
 *
 * `file` in each finding's message is the collection-relative path
 * (`relPosix`), or the dependency's `dep:<name>/<artifact>` id when the
 * declaration came from an imported artifact.
 *
 * Unreadable or unparsable files are skipped — the loader itself reports
 * those (as a load error / `meta verify`'s own failure path); duplicating
 * that diagnosis here would just be a second, worse-informed version of the
 * same message.
 */
export async function lintOverlays(
  collection: Collection,
  readSource: ReadSource,
): Promise<Diagnostic[]> {
  // type -> resolutionKey -> every declaration seen for it, in file order.
  const byType = new Map<string, Map<string, Declaration[]>>();

  for (const path of collection.files) {
    let declared: ReadonlyArray<DeclaredTopLevelKey>;
    try {
      const source = readSource(path);
      const content = await source.read();
      declared = await declaredTopLevelKeys(content, source.format);
    } catch {
      continue;
    }
    const file = collection.fileIds.get(path) ?? relPosix(collection.configDir, path);
    for (const decl of declared) {
      let byKey = byType.get(decl.type);
      if (byKey === undefined) {
        byKey = new Map<string, Declaration[]>();
        byType.set(decl.type, byKey);
      }
      const list = byKey.get(decl.key) ?? [];
      list.push({ file, overlay: decl.overlay });
      byKey.set(decl.key, list);
    }
  }

  const diags: Diagnostic[] = [];
  for (const byKey of byType.values()) {
    for (const [fqn, declarations] of byKey) {
      if (declarations.length < 2) continue;
      let baseSeen = false;
      for (const decl of declarations) {
        if (decl.overlay) continue;
        if (!baseSeen) {
          // The first unflagged declaration is the base — nothing to report.
          baseSeen = true;
          continue;
        }
        diags.push(
          warn(
            WARN_OVERLAY_IMPLICIT,
            `${fqn} is redeclared in ${decl.file} without overlay: true — add the flag ` +
              `so a removed or renamed target fails loudly (ERR_OVERLAY_NO_TARGET) instead ` +
              `of silently becoming a new object`,
          ),
        );
      }
    }
  }
  return diags;
}
