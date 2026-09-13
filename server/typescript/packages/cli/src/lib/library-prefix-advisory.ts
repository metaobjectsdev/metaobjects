// FR-043 §3.5 — `metaobjects::` in an adopter's own metadata, with no ejection provenance.
//
// The loader already REFUSES a node in a library's package while that library is opted
// in (ERR_LIBRARY_PACKAGE_COLLISION / ERR_LIBRARY_PACKAGE_NOT_OWNED). This is the other
// half, and it is advisory on purpose: with the library NOT opted in there is nothing
// broken to refuse — the nodes are simply the adopter's, sitting under a prefix this
// project ships libraries into.
//
// Two ways to arrive there, and the advice is the same for both:
//
//   a hand-copy, rather than `meta eject <library>` — no provenance header, so nothing
//     can tell later where it came from or how far it has drifted;
//   a package名 chosen freely that happens to start `metaobjects::` — which will
//     collide the day a library ships into it.
//
// A file carrying the eject marker is exempt: that IS the provenance, and `meta eject
// --list` reports its staleness.
import { readFile } from "node:fs/promises";
import { EJECT_MARKER } from "./library-eject.js";
import type { MetaData } from "@metaobjectsdev/metadata";

/** The prefix every shipped library declares into. */
export const LIBRARY_PACKAGE_PREFIX = "metaobjects::";

export interface LibraryPrefixFinding {
  file: string;
  fqn: string;
  message: string;
}

/**
 * Root nodes under `metaobjects::` whose file carries no ejection provenance.
 *
 * Reads the loaded tree for the nodes and the FILES only for the marker — the marker is
 * `meta eject`'s own bookkeeping, not metadata, so there is nothing in the model to read
 * it from.
 */
export async function scanForUnprovenancedLibraryPrefix(
  root: MetaData,
  ownFiles: readonly string[],
  projectRoot: string,
): Promise<LibraryPrefixFinding[]> {
  const suspect = root
    .children()
    .filter((n) => n.resolutionKey().startsWith(LIBRARY_PACKAGE_PREFIX));
  if (suspect.length === 0) return [];

  // Which of this project's own files carry the marker — read once, not per node.
  const provenanced = new Set<string>();
  for (const file of ownFiles) {
    try {
      if ((await readFile(file, "utf8")).slice(0, 400).includes(EJECT_MARKER)) {
        provenanced.add(file.slice(projectRoot.length + 1));
      }
    } catch {
      // unreadable — it contributes no exemption, which is the safe direction
    }
  }

  const out: LibraryPrefixFinding[] = [];
  for (const node of suspect) {
    const files = "files" in node.source ? node.source.files : [];
    // A node the SHIPPED library contributed is not the adopter's — `library:` ids say so.
    if (files.some((f) => f.startsWith("library:"))) continue;
    if (files.some((f) => provenanced.has(f) || [...provenanced].some((p) => p.endsWith(f)))) continue;
    out.push({
      file: files[0] ?? "(unknown)",
      fqn: node.resolutionKey(),
      message:
        `${node.resolutionKey()} is declared under "${LIBRARY_PACKAGE_PREFIX}", which is where ` +
        `MetaObjects ships its libraries, and no file declaring it carries an ejection header. ` +
        `If it was copied from a library, re-copy it with 'meta eject <library>' so its origin ` +
        `and its drift stay legible; if it is your own, move it to a package you own — a later ` +
        `release shipping a node of that name would merge into yours.`,
    });
  }
  return out;
}
