// Filesystem-backed provider: resolves a `group/source` reference to
// <root>/<group>/<source>.mustache. NODE-ONLY — it is reachable solely through
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

/** The default template file extension, shared with every other port. */
export const DEFAULT_TEMPLATE_EXTENSION = ".mustache";

const REF_SEPARATOR = "/";
const PARENT_SEGMENT = "..";

export class FilesystemProvider implements Provider {
  private readonly root: string;

  constructor(root: string, private readonly extension: string = DEFAULT_TEMPLATE_EXTENSION) {
    this.root = resolve(root);
  }

  resolve(ref: string): string | undefined {
    const segments = ref.split(REF_SEPARATOR).filter((s) => s.length > 0);
    if (segments.length === 0 || segments.includes(PARENT_SEGMENT)) return undefined;

    const candidate = resolve(this.root, ...segments) + this.extension;
    // Path-traversal guard (belt-and-suspenders after the `..` check).
    if (!candidate.startsWith(this.root + sep)) return undefined;

    try {
      if (!statSync(candidate).isFile()) return undefined;
      return readFileSync(candidate, "utf8");
    } catch {
      return undefined;
    }
  }
}
