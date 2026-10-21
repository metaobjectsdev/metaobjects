// docs-ref.ts — where a guide URL points, derived from the running version.
//
// A guide URL that says `blob/main` moves after the release is cut, and no installed
// package ships the guides, so the CLI and the agent context name the TAG of the release
// they belong to: `blob/v1.1.0/...`. A prerelease version has no tag, so it keeps `main`.
// The repository URL and the rule live here once; nothing else spells either. This file is
// pure (browser-safe, reachable from the root entry); reading the running version is the
// Node-side `release-docs.ts`.

/** The public repository the guides live in. */
export const DOCS_REPO_URL = "https://github.com/metaobjectsdev/metaobjects";

/** The branch a prerelease or an unresolvable version links to. */
export const DOCS_DEFAULT_REF = "main";

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The git ref a guide URL pins to: `v<version>` for a release (`1.1.0` → `v1.1.0`),
 * `main` for anything with no tag — a prerelease (`1.1.0-rc.7`), the `0.0.0` sentinel a
 * port stamps when it cannot resolve its own version, or text that is not a version.
 */
export function docsRefForVersion(version: string): string {
  const v = version.trim();
  return RELEASE_VERSION.test(v) && v !== "0.0.0" ? `v${v}` : DOCS_DEFAULT_REF;
}

/** `https://github.com/<repo>/blob/<ref>/<repoRelativePath>`. */
export function docsBlobUrl(repoRelativePath: string, ref: string = DOCS_DEFAULT_REF): string {
  return `${DOCS_REPO_URL}/blob/${ref}/${repoRelativePath.replace(/^\/+/, "")}`;
}

/**
 * Rewrite every `…/blob/main/` link into this repository, inside `text`, to `ref`.
 * Authors of shipped prose write `main` as the placeholder; the pin is applied once, at
 * render time, so no template carries a version.
 */
export function pinDocsRefs(text: string, ref: string): string {
  if (ref === DOCS_DEFAULT_REF) return text;
  return text.split(`${DOCS_REPO_URL}/blob/${DOCS_DEFAULT_REF}/`).join(`${DOCS_REPO_URL}/blob/${ref}/`);
}
