// library-sources.ts — resolves MetaDataSource instances for shipped library packages.
//
// On-disk-first: if the repo-root library/ tree is reachable (dev / installed-from-source
// layout), a FileSource is returned so edits to the on-disk YAML are picked up immediately.
// Embedded fallback: when the binary is compiled (bun --compile) or the library/ directory
// is absent, the content embedded in embedded-library.generated.ts is used.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSource } from "../loader/sources/file-source.js";
import { InMemoryStringSource } from "../loader/meta-data-source.js";
import type { MetaDataSource } from "../loader/meta-data-source.js";
import { EMBEDDED_LIBRARY, EMBEDDED_LIBRARY_MANIFESTS } from "./embedded-library.generated.js";

/** One layer of a library, as its manifest declares it. */
export interface LibraryLayer {
  /** Refs (path under `library/` minus `.yaml`) this layer contributes, in order. */
  readonly refs: readonly string[];
  readonly description?: string;
}

/** A library's `library.json`, parsed. Only the fields this module reads are typed;
 *  the catalog reads the rest off the same text. */
export interface LibraryManifest {
  readonly name: string;
  readonly kind?: string;
  readonly stability?: string;
  readonly since?: string;
  readonly description?: string;
  readonly useWhen?: string;
  readonly packages?: readonly string[];
  /** Layer token → layer. The CORE layer's token is the empty string. */
  readonly layers?: Readonly<Record<string, LibraryLayer>>;
  readonly generators?: ReadonlyArray<{ readonly name: string; readonly anchor?: string }>;
  readonly runtime?: Readonly<Record<string, readonly string[]>>;
}

const MANIFESTS: Readonly<Record<string, LibraryManifest>> = (() => {
  const out: Record<string, LibraryManifest> = {};
  for (const [name, text] of Object.entries(EMBEDDED_LIBRARY_MANIFESTS)) {
    out[name] = JSON.parse(text) as LibraryManifest;
  }
  return out;
})();

/** Every shipped library's parsed manifest, keyed by name. */
export function libraryManifests(): Readonly<Record<string, LibraryManifest>> {
  return MANIFESTS;
}

/**
 * Split a selection token into `[library, layer]` — `"iam"` → `["iam", ""]`,
 * `"iam/db"` → `["iam", "db"]`.
 *
 * Path-like, so `libraries` stays `string[]` and no config schema moves. Only ONE
 * separator is meaningful; anything after a second is part of the layer token, which
 * keeps a typo failing loudly rather than resolving to a prefix.
 */
export function splitLayerToken(token: string): [string, string] {
  const i = token.indexOf("/");
  return i === -1 ? [token, ""] : [token.slice(0, i), token.slice(i + 1)];
}

/**
 * Locate the repo-root `library/` directory by walking up from this module's
 * location until a directory contains BOTH `library/` and `server/` (the two
 * structural anchors that identify the repo root). Returns the path to the
 * `library/` subdirectory if found, or `undefined` when absent (compiled binary).
 */
function libraryDirOnDisk(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "library")) && existsSync(join(dir, "server"))) {
      return join(dir, "library");
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

// Cache the on-disk location: resolved once per process.
let _cache: { dir: string | undefined } | undefined;

function getLibraryDir(): string | undefined {
  return (_cache ??= { dir: libraryDirOnDisk() }).dir;
}

/**
 * The library package names this build ships, sorted.
 *
 * `librarySources` skips an unrecognised package silently — the right behaviour for a
 * programmatic caller asking for something a given version may not ship. A name a human
 * typed into a config file is a different case: skipping it silently resurfaces later as
 * `ERR_UNRESOLVED_SUPER` pointing at the adopter's own metadata, which is the wrong place
 * to go looking. Config readers use this to refuse an unknown name and say what IS
 * available (Python's `project_config` draws the same line, in the same place).
 */
export function knownLibraryPackages(): string[] {
  return Object.keys(MANIFESTS).sort();
}

/**
 * Every package name a shipped library OWNS, across every library and layer.
 *
 * The provenance key for FR-043 §5.4 — object coverage activates on adopter-authored
 * requirements only, and "adopter-authored" means "declared outside every library
 * package". It reads the manifests rather than node source ids deliberately: `packages`
 * is a manifest fact the standalone gate resolves against the library loaded alone,
 * while a source id differs between the on-disk dev layout (an absolute path) and the
 * embedded one (`library:<ref>.yaml`), so a rule keyed on that would hold here and stop
 * holding in an installed build.
 */
export function libraryPackages(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const manifest of Object.values(MANIFESTS)) {
    for (const pkg of manifest.packages ?? []) out.add(pkg);
  }
  return out;
}

/**
 * Every selection token this build accepts, sorted — `["ai", "ai/db", "iam", "iam/db"]`.
 *
 * What a config error message should print, so an adopter who typed `iam/database` is
 * shown the layer they meant rather than only the library they got right.
 */
export function knownLibraryTokens(): string[] {
  const out: string[] = [];
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    for (const layer of Object.keys(manifest.layers ?? { "": { refs: [] } })) {
      out.push(layer === "" ? name : `${name}/${layer}`);
    }
  }
  return out.sort();
}

/**
 * `MetaDataSource` instances for the requested library selection.
 *
 * **Layer-granular.** A token is `<library>` or `<library>/<layer>`; the CORE layer is
 * the bare name. This used to be package-granular — every ref under a library came back
 * for a bare `"iam"` — which under the layered design would have handed an adopter the
 * db and ui layers they did not ask for, and with them a migration proposing nine tables.
 *
 * **`"iam/db"` IMPLIES `"iam"`**, and the implication is not a convenience: a db layer is
 * nothing but `overlay: true` redeclarations, and an overlay whose target was never
 * declared is `ERR_OVERLAY_NO_TARGET`. Resolving the layer without its core would produce
 * exactly that error, so implying it is the only coherent reading.
 *
 * Refs are de-duplicated and returned in a stable order — core first, then each requested
 * layer in the manifest's own order — because an overlay must be parsed after its base
 * even though ADR-0055 applies overlays in a deferred pass.
 *
 * An unrecognised token contributes nothing and is skipped silently: that is right for a
 * programmatic caller asking for something a given version may not ship. A name a HUMAN
 * typed is a different case and is refused by the config readers, which call
 * {@link knownLibraryTokens} to say what is available.
 *
 * @param selection - Tokens, e.g. `["iam", "iam/db"]`.
 */
export function librarySources(selection: string[]): MetaDataSource[] {
  const dir = getLibraryDir();
  const refs: string[] = [];
  const seen = new Set<string>();

  const add = (ref: string): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };

  // Core layers first, across every requested library, so a db layer named before its
  // core in the config still parses after it.
  //
  // A token whose LAYER is unknown is dropped whole, not reduced to its core. The core is
  // implied by a VALID layer token; implying it from an invalid one would answer a
  // mistyped `iam/database` with an inert core and no tables — "I asked for the db layer
  // and got nothing" with no diagnostic, which is the worst of the available outcomes.
  const wanted = selection
    .map(splitLayerToken)
    .filter(([lib, layer]) => lib in MANIFESTS && (MANIFESTS[lib]!.layers ?? {})[layer] !== undefined);
  for (const [lib] of wanted) {
    for (const ref of MANIFESTS[lib]!.layers?.[""]?.refs ?? []) add(ref);
  }
  for (const [lib, layer] of wanted) {
    if (layer === "") continue;
    for (const ref of MANIFESTS[lib]!.layers?.[layer]?.refs ?? []) add(ref);
  }

  const out: MetaDataSource[] = [];
  for (const ref of refs) {
    if (dir !== undefined) {
      const path = join(dir, `${ref}.yaml`);
      if (existsSync(path)) {
        out.push(new FileSource(path));
        continue;
      }
    }
    const embedded = EMBEDDED_LIBRARY[ref];
    if (embedded !== undefined) {
      out.push(
        new InMemoryStringSource(embedded, {
          id: `library:${ref}.yaml`,
          format: "yaml",
        }),
      );
    } else {
      throw new Error(
        `library ref "${ref}" has no on-disk file and no embedded entry — ` +
          `the embedded library module is stale; run scripts/generate-embedded-library.ts`,
      );
    }
  }

  return out;
}
