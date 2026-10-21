// release-docs.ts — guide URLs pinned to the release this toolchain belongs to.
//
// Node-only (reads package.json), so it sits behind its own subpath
// (`@metaobjectsdev/metadata/release-docs`) and is never reachable from the root entry,
// which must stay browser-safe. The pure rule (`docsRefForVersion`) is in `docs-ref.ts`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsBlobUrl, docsRefForVersion } from "./docs-ref.js";
import { PHYSICAL_NAMING_MIGRATION_GUIDE_PATH } from "./naming.js";

let cachedVersion: string | undefined;

/**
 * The version of this package, read from its own package.json (walking up from this
 * module). All `@metaobjectsdev/*` npm packages release in lockstep, so it is also the
 * version of the toolchain a message is printed by. "0.0.0" when not found.
 */
export function metadataPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@metaobjectsdev/metadata" && pkg.version) return (cachedVersion = pkg.version);
      } catch {
        // not our manifest / unreadable — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedVersion = "0.0.0");
}

/** A guide URL pinned to the release this package belongs to. */
export function guideUrl(repoRelativePath: string): string {
  return docsBlobUrl(repoRelativePath, docsRefForVersion(metadataPackageVersion()));
}

/** The physical-naming migration guide, pinned: what `physicalNamingRemovedMessage` is given. */
export function physicalNamingGuideUrl(): string {
  return guideUrl(PHYSICAL_NAMING_MIGRATION_GUIDE_PATH);
}
