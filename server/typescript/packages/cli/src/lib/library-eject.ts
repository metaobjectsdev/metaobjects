// `meta eject <library>` — FR-043 §3.4, the copy door for a shipped library's METADATA.
//
// ADR-0034 ruled that a reference GENERATOR is copied into the adopter's repo because
// the adopter owns their code. §3.4 extends the same ruling to declared design, and
// makes it the EXPECTED mode rather than the fallback: a library is first a reference —
// something to copy, rename, and cut down. Using one in place, tracking upstream, is the
// deliberate minority choice.
//
// Two things follow, and both are here rather than in the generator path:
//
//   The destination is `Collection.sourceRoots[0]` — the project's first DECLARED
//   source root, resolved through `resolveCollection()`. Never `metaobjects/`: that
//   string is the default value of `sources` and nothing else (CLAUDE.md names the five
//   sites allowed to spell it, and this is not one of them).
//
//   Every file carries a provenance header. It is what makes the copy's origin legible
//   a year later, what `--list` reads to report staleness against the shipped tree, and
//   what carries the ONE instruction that makes the eject complete: remove the library
//   from `libraries`, or both trees load and merge (ERR_LIBRARY_PACKAGE_COLLISION).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MetaDataLoader, canonicalSerialize, type MetaData } from "@metaobjectsdev/metadata";
import {
  libraryManifests, libraryRefSource, libraryRefs, librarySources,
  knownLibraryTokens, splitLayerToken,
} from "@metaobjectsdev/metadata/library";
import { resolveCollection } from "@metaobjectsdev/sdk";
import { cliVersion } from "./version.js";

/** The first line of every ejected file — the marker `--list` scans for. */
export const EJECT_MARKER = "# meta-eject:";

/** True when `name` is a shipped library rather than a generator. */
export function isLibraryName(name: string): boolean {
  return name in libraryManifests();
}

/** Every shipped library name, sorted. */
export function ejectableLibraryNames(): string[] {
  return Object.keys(libraryManifests()).sort();
}

/**
 * Where an ejected ref lands: `meta.<library>.<file>.yaml`.
 *
 * Not the library's own basename. `model.yaml` / `db.yaml` / `requirements.yaml` are
 * meaningful inside `library/iam/` and meaningless in a directory holding an
 * application's whole model — and three libraries ejected into one root would collide
 * outright. The `meta.<concept>.<...>` shape is the file-naming convention this project
 * documents.
 */
export function ejectedFileName(library: string, ref: string): string {
  return `meta.${library}.${basename(ref)}.yaml`;
}

function header(library: string, ref: string): string {
  return [
    `${EJECT_MARKER} library=${library} ref=${ref} cli=${cliVersion()}`,
    `# Copied from the MetaObjects shipped library "${library}". YOU OWN THIS FILE: rename`,
    `# the package, delete what you do not need, change anything. Nothing regenerates it,`,
    `# and no gate compares it to the shipped tree except \`meta eject --list\`.`,
    `#`,
    `# ONE STEP REMAINS: remove "${library}" (and any "${library}/<layer>") from`,
    `# \`libraries\` in .metaobjects/config.json. Left there, the shipped tree and this`,
    `# copy BOTH load and merge — additions take effect and deletions do not, because the`,
    `# library still declares what you removed. The loader refuses that outright`,
    `# (ERR_LIBRARY_PACKAGE_COLLISION) rather than letting it run.`,
    "",
  ].join("\n");
}

export interface EjectedLibraryFile {
  ref: string;
  /** Path relative to the project root. */
  path: string;
  status: "created" | "preserved" | "replaced";
}

export interface LibraryEjectResult {
  library: string;
  /** Absolute destination directory. */
  root: string;
  files: EjectedLibraryFile[];
  /** The tokens for this library the project currently declares — what to remove. */
  stillOptedIn: readonly string[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function ejectLibrary(opts: {
  cwd: string;
  name: string;
  force?: boolean;
}): Promise<LibraryEjectResult> {
  const manifest = libraryManifests()[opts.name];
  if (manifest === undefined) {
    throw new Error(
      `unknown library "${opts.name}". Shipped libraries: ${ejectableLibraryNames().join(", ")}.`,
    );
  }
  const collection = await resolveCollection(opts.cwd);
  const root = collection.sourceRoots[0];
  if (root === undefined) {
    throw new Error(
      `this project declares no metadata source root, so there is nowhere to put ` +
        `"${opts.name}". Declare "sources" in .metaobjects/config.json, or run 'meta init'.`,
    );
  }

  await mkdir(root, { recursive: true });
  const files: EjectedLibraryFile[] = [];
  for (const ref of libraryRefs(opts.name)) {
    const text = header(opts.name, ref) + (await libraryRefSource(ref).read());
    const name = ejectedFileName(opts.name, ref);
    const abs = join(root, name);
    const existed = await fileExists(abs);
    if (existed && opts.force !== true) {
      files.push({ ref, path: name, status: "preserved" });
      continue;
    }
    await writeFile(abs, text, "utf8");
    files.push({ ref, path: name, status: existed ? "replaced" : "created" });
  }

  return {
    library: opts.name,
    root,
    files,
    stillOptedIn: collection.libraries.filter((t) => splitLayerToken(t)[0] === opts.name),
  };
}

// ---------------------------------------------------------------------------
// staleness — `meta eject --list`
// ---------------------------------------------------------------------------

export interface LibraryStaleness {
  library: string;
  /** Files in this project carrying the eject marker for this library. */
  files: string[];
  verdict: "identical" | "differs" | "unreadable";
  /** Nodes present in both whose own-mode serialization differs. */
  changed: number;
  /** Nodes the SHIPPED tree has that the ejected copy does not — upstream moved. */
  upstreamOnly: number;
  /** Nodes the ejected copy has that the shipped tree does not — your additions. */
  localOnly: number;
  /** Why the comparison could not be made, when `verdict` is "unreadable". */
  reason?: string;
  /** Still named in `libraries` — the ejection is not finished. */
  stillOptedIn: boolean;
}

/** Root-level nodes keyed by NAME, canonically serialized in OWN mode.
 *
 *  By name rather than by resolution key, because §3.4 says an adopter who ejects "may
 *  rename the package freely" — keying on the FQN would report every node of a renamed
 *  copy as both upstream-only and local-only, which is the least useful answer
 *  available. Own mode, because the question is what each file DECLARES; the effective
 *  tree would fold a shipped base's fields into a subtype and report a difference that
 *  is not in either file. */
function ownNodesByName(root: MetaData): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of root.children()) {
    // The node's OWN package, neutralized in its serialization — for the same reason the
    // keying is by name. A rename reaches the `package` key AND every `extends` inside
    // the node, so comparing the raw text would report a renamed copy as wholly changed:
    // the loudest possible answer to the one edit §3.4 explicitly invites.
    const pkg = node.package ?? node.fileDefaultPackage ?? "";
    const text = canonicalSerialize(node);
    out.set(node.name, pkg === "" ? text : text.replaceAll(pkg, "<package>"));
  }
  return out;
}

/** Every project file carrying an eject marker, grouped by library. */
async function ejectedFilesByLibrary(files: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    let head: string;
    try {
      head = (await readFile(file, "utf8")).slice(0, 400);
    } catch {
      continue;
    }
    const match = new RegExp(`^${EJECT_MARKER} library=(\\S+)`, "m").exec(head);
    const library = match?.[1];
    if (library === undefined) continue;
    out.set(library, [...(out.get(library) ?? []), file]);
  }
  return out;
}

/**
 * Per-library staleness for the copies THIS project owns.
 *
 * The same gap `--list` closes for generators, one level up: an ejected copy can sit any
 * number of releases behind the tree it came from and nothing compares the two. The
 * comparison is structural, through the canonical serializer, so re-indentation and key
 * order never show up — the only thing that can be reported is a declaration that
 * actually changed.
 */
export async function libraryStaleness(cwd: string): Promise<LibraryStaleness[]> {
  let collection;
  try {
    collection = await resolveCollection(cwd);
  } catch {
    return []; // no project — nothing is ejected here
  }
  const byLibrary = await ejectedFilesByLibrary(collection.ownFiles);
  const selected = new Set(collection.libraries.map((t) => splitLayerToken(t)[0]));

  const rows: LibraryStaleness[] = [];
  for (const [library, files] of [...byLibrary].sort(([a], [b]) => a.localeCompare(b))) {
    const row: LibraryStaleness = {
      library,
      files: files.map((f) => f.slice(cwd.length + 1)),
      verdict: "identical",
      changed: 0,
      upstreamOnly: 0,
      localOnly: 0,
      stillOptedIn: selected.has(library),
    };
    if (!(library in libraryManifests())) {
      rows.push({ ...row, verdict: "unreadable", reason: `this build ships no library "${library}"` });
      continue;
    }

    // Both trees WHOLE, never file by file: a db layer is nothing but `overlay: true`
    // redeclarations, so loading one alone is ERR_OVERLAY_NO_TARGET by construction.
    const tokens = knownLibraryTokens().filter((t) => splitLayerToken(t)[0] === library);
    const shipped = await new MetaDataLoader({ strict: true }).load(librarySources(tokens));
    const { FileSource } = await import("@metaobjectsdev/metadata/core");
    const local = await new MetaDataLoader({ strict: true }).load(
      files.map((f) => new FileSource(f)),
    );
    if (local.errors.length > 0) {
      rows.push({
        ...row,
        verdict: "unreadable",
        reason: `the ejected copy does not load on its own: ${local.errors[0]!.message}`,
      });
      continue;
    }

    const up = ownNodesByName(shipped.root);
    const mine = ownNodesByName(local.root);
    for (const [name, text] of up) {
      if (!mine.has(name)) row.upstreamOnly++;
      else if (mine.get(name) !== text) row.changed++;
    }
    for (const name of mine.keys()) if (!up.has(name)) row.localOnly++;
    row.verdict =
      row.changed + row.upstreamOnly + row.localOnly === 0 ? "identical" : "differs";
    rows.push(row);
  }
  return rows;
}
