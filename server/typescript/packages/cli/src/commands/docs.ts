// `meta docs <metadata> --out <dir>` — STANDALONE neutral metadata docs.
//
// Emits one neutral page per entity (`<Entity>.md`) and one per
// `template.output` (`<Template>.md`) from metadata ALONE — no gen config, no
// codegen pipeline. It is the Tier-2 delivery (like `migrate`): runnable from
// the compiled `meta` binary.
//
// DRY: this command does NOT re-walk objects/templates. It builds the same
// GenContext the codegen runner builds for the `docsFile()` generator and
// calls that generator, then writes the returned files. The neutrality of the
// output is therefore guaranteed — it is byte-for-byte the same generator the
// `meta gen` pipeline runs (gated by the docs conformance fixture).

import { resolve as resolvePath } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { log } from "../lib/log.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { loadMemory, DEFAULT_METADATA_DIR } from "@metaobjectsdev/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  makeRenderContext,
  buildPkMap,
  buildRelationMap,
} from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { docsFile } from "@metaobjectsdev/codegen-ts/generators";

type DocsLayout = "flat" | "package";

interface DocsFlags {
  /** Project root holding `metaobjects/` (the metadata to document). */
  metadata: string;
  /** Output directory for the rendered pages. */
  out: string;
  /** Page-placement layout. `flat` (default) writes `<Name>.md` at the out
   *  root; `package` folds pages under package-path subdirs (collision-proof
   *  for multi-package models with repeated short names). */
  layout: DocsLayout;
  /** Optional override for the project root used to resolve adopter
   *  `templates/` overrides. Defaults to the metadata root. */
  templates?: string;
}

function parseLayout(v: string | undefined, flag: string): DocsLayout {
  if (v === undefined) throw new Error(`${flag} requires flat|package`);
  if (v !== "flat" && v !== "package") {
    throw new Error(`${flag} must be "flat" or "package" (got "${v}")`);
  }
  return v;
}

function parseDocsArgs(argv: string[], cwd: string): DocsFlags {
  let metadata: string | undefined;
  let out: string | undefined;
  let templates: string | undefined;
  let layout: DocsLayout | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out" || a === "-o") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a directory argument`);
      out = v;
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--layout") {
      layout = parseLayout(argv[++i], a);
    } else if (a.startsWith("--layout=")) {
      layout = parseLayout(a.slice("--layout=".length), "--layout");
    } else if (a === "--templates") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a directory argument`);
      templates = v;
    } else if (a.startsWith("--templates=")) {
      templates = a.slice("--templates=".length);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (metadata === undefined) {
      metadata = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return {
    // `<metadata>` is the project root that contains metaobjects/; default cwd
    // (mirrors how migrate/gen treat the working directory as the root).
    metadata: metadata ?? cwd,
    // Default out dir, resolved against the metadata root below.
    out: out ?? "./docs",
    // Default flat preserves today's single-package output (+ existing goldens).
    layout: layout ?? "flat",
    ...(templates !== undefined ? { templates } : {}),
  };
}

export async function docsCommand(args: string[], cwd: string): Promise<number> {
  let flags: DocsFlags;
  try {
    flags = parseDocsArgs(args, cwd);
  } catch (err) {
    log.error(`docs: ${(err as Error).message}`);
    return 2;
  }

  const metaRoot = resolvePath(cwd, flags.metadata);
  // The project root used to resolve adopter `templates/` overrides; the
  // framework defaults sit underneath via projectProvider's chain.
  const projectRoot = flags.templates !== undefined
    ? resolvePath(cwd, flags.templates)
    : metaRoot;
  const outDir = resolvePath(metaRoot, flags.out);

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers (e.g. a project's custom field/object subtypes). Unlike `gen`,
  // docs does NOT require a config — the Tier-2 "metadata alone" promise must
  // hold for config-less projects. If the config is absent or invalid, fall
  // back to defaults; the loader still surfaces a stable unknown-subtype error
  // if the metadata genuinely uses an unregistered type.
  let configProviders: NonNullable<Awaited<ReturnType<typeof loadMetaobjectsConfig>>["providers"]> | undefined;
  // The config lives alongside metaobjects/ at the metadata root (metaRoot);
  // projectRoot only diverges when --templates overrides the template lookup.
  // Only attempt the load when the file is actually present: absence is the
  // expected config-less case (stay silent), but a config that EXISTS yet fails
  // to load is surfaced as a warning rather than silently degrading to
  // provider-less docs — otherwise a custom-type project would later fail with a
  // cryptic unknown-subtype error instead of the real config error.
  if (existsSync(join(metaRoot, "metaobjects.config.ts"))) {
    try {
      const forgeConfig = await loadMetaobjectsConfig(metaRoot);
      configProviders = forgeConfig.providers;
    } catch (err) {
      log.warn(
        `docs: metaobjects.config.ts failed to load (${(err as Error).message}); ` +
          `generating docs without its providers`,
      );
      configProviders = undefined;
    }
  }

  // Load metadata standalone — same loader path as migrate/gen. Threads any
  // consumer providers from the config so custom types resolve.
  let root;
  try {
    root = await loadMemory(metaRoot, {
      ...(configProviders !== undefined ? { providers: configProviders } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (!existsSync(join(metaRoot, DEFAULT_METADATA_DIR))) {
      log.error(`docs: no metaobjects/ found in ${metaRoot}; run 'meta init' to scaffold`);
    } else {
      log.error(`docs: failed to load metadata: ${msg}`);
    }
    return 2;
  }

  // Build the same GenContext the codegen runner builds for docsFile(). The
  // dialect only affects column-type hints on the entity page; "sqlite" is the
  // neutral default (migrate's offline path uses the same fallback chain).
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir,
    dbImport: "",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: {
      outDir,
      extStyle: "none",
      dbImport: "",
      dialect: "sqlite",
      outputLayout: flags.layout,
    } as never,
    renderContext,
    projectRoot,
    warn: (msg) => log.warn(`docs: ${msg}`),
  };

  let files;
  try {
    files = await docsFile().generate(ctx);
  } catch (err) {
    const msg = (err as Error).message;
    // Duplicate output path (silent-overwrite backstop): the generator already
    // names both colliding FQNs + the path and starts with "docs:". Surface it
    // verbatim as a clean non-zero exit (no double prefix, no stack trace).
    if (msg.startsWith("docs: duplicate output path")) {
      log.error(msg);
      return 1;
    }
    // The framework templates resolve from disk; inside the compiled `meta`
    // binary they live on a virtual fs the provider cannot read. Surface that
    // as an actionable message rather than a cryptic render failure.
    if (/entity-page|template-page|failed rendering|ENOENT|not found/i.test(msg)) {
      log.error(
        `docs: failed to render — templates not found. ` +
        `Run 'meta docs' from an installed package layout (with on-disk ` +
        `templates/), not the standalone binary, OR drop your own ` +
        `templates/docs/entity-page.md.mustache + template-page.md.mustache. (${msg})`,
      );
    } else {
      log.error(`docs: ${msg}`);
    }
    return 1;
  }

  try {
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      const path = resolvePath(outDir, f.path);
      await mkdir(resolvePath(path, ".."), { recursive: true });
      await writeFile(path, f.content, "utf8");
    }
  } catch (err) {
    log.error(`docs: failed to write pages: ${(err as Error).message}`);
    return 1;
  }

  // Summary: docsFile() emits one page per entity first, then one per
  // template.output. The entity count is the matched object count; the rest
  // are template pages.
  const entityCount = root.objects().filter(ctx.matches).length;
  const templateCount = files.length - entityCount;
  log.info(
    `meta docs — wrote ${entityCount} entity page(s) + ${templateCount} template page(s) → ${outDir}`,
  );
  return 0;
}
