// Filesystem-backed provider: resolves a `group/source` reference to
// <root>/<group>/<source>.mustache — or, when no Mustache file exists, to a Jinja
// file beside it (`.jinja`, `.j2`, `.jinja2`; ADR-0061), whose extension then
// selects the Jinja engine. NODE-ONLY — it is reachable solely through
// the `@metaobjectsdev/render/providers` subpath so the package's root entry
// stays importable in a browser bundle.
//
// Mirrors the C# MetaObjects.Render.FilesystemProvider, the Java
// com.metaobjects.render.FilesystemProvider and the Python
// metaobjects.render.FilesystemProvider: read the file when present, return
// undefined when absent / unreadable / not a regular file, and refuse a ref that
// escapes the root (undefined, never a throw).

import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Provider } from "./provider.js";
import { JINJA_EXTENSIONS, MUSTACHE_EXTENSION, engineForExtension, type TemplateEngine } from "./engine.js";

/** The default template file extension, shared with every other port. */
export const DEFAULT_TEMPLATE_EXTENSION = MUSTACHE_EXTENSION;

const REF_SEPARATOR = "/";
const PARENT_SEGMENT = "..";

export class FilesystemProvider implements Provider {
  private readonly root: string;
  private readonly extensions: readonly string[];

  /**
   * @param extension the one extension to read. Omitted, the provider reads
   *        `<ref>.mustache` and falls back to the Jinja extensions; given — even as
   *        `.mustache` — it reads only that extension.
   */
  constructor(root: string, extension?: string) {
    this.root = resolve(root);
    this.extensions = extension === undefined
      ? [DEFAULT_TEMPLATE_EXTENSION, ...JINJA_EXTENSIONS]
      : [extension];
  }

  resolve(ref: string): string | undefined {
    const found = this.find(ref);
    if (found === undefined) return undefined;
    try {
      return readFileSync(found.path, "utf8");
    } catch {
      return undefined;
    }
  }

  engineOf(ref: string): TemplateEngine | undefined {
    const found = this.find(ref);
    return found === undefined ? undefined : engineForExtension(found.extension);
  }

  private find(ref: string): { path: string; extension: string } | undefined {
    const segments = ref.split(REF_SEPARATOR).filter((s) => s.length > 0);
    if (segments.length === 0 || segments.includes(PARENT_SEGMENT)) return undefined;
    const base = resolve(this.root, ...segments);
    // Path-traversal guard (belt-and-suspenders after the `..` check).
    if (!base.startsWith(this.root + sep)) return undefined;
    for (const extension of this.extensions) {
      const path = base + extension;
      try {
        if (statSync(path).isFile()) return { path, extension };
      } catch {
        // absent — try the next extension
      }
    }
    return undefined;
  }
}
