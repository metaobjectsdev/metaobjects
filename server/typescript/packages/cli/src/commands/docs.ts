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

import { resolve as resolvePath, basename, isAbsolute } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { log } from "../lib/log.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { loadMemory, resolveCollection, resolveConfigDir, type Collection } from "@metaobjectsdev/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  makeRenderContext,
  buildPkMap,
  buildRelationMap,
  resolveDocsConfig,
  apiLabel,
} from "@metaobjectsdev/codegen-ts";
import type {
  GenContext,
  EmittedFile,
  ResolvedDocsConfig,
  DocsSurface,
} from "@metaobjectsdev/codegen-ts";
import { docsFile, apiDocsFile } from "@metaobjectsdev/codegen-ts/generators";
import { composeRegistry, coreProviders, renderCoreMetamodelDocs } from "@metaobjectsdev/metadata";
import type { MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { generateSite, SITE_TEMPLATE_NAMES, SITE_ASSET_NAMES, readSiteFile } from "@metaobjectsdev/docs-site";

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
  /** Optional directory holding the prompt `.mustache` sources, for a project
   *  whose templates live outside the conventional `metaobjects/` or `templates/`
   *  roots (e.g. `data/templates/`). Added to the `--site` prompt-source search
   *  path so the HTML site can show the prompt TEXT. Mirrors `verify --prompts`. */
  prompts?: string;
  /** Which doc surfaces to emit, when overridden on the CLI. `--model` ⇒
   *  ["model"], `--api` ⇒ ["api"], both ⇒ ["model","api"]. Unset ⇒ defer to the
   *  resolved `docs:` config (default both). */
  surfaces?: DocsSurface[];
  /** Optional base URL override for cross-surface links (resolveDocsConfig). */
  baseUrl?: string;
  /** Whether `--out` was explicitly passed (so the resolver knows to override
   *  the config's `docs.outDir` rather than fall back to the parse default). */
  outProvided: boolean;
  /** Whether `--layout` was explicitly passed (same override semantics). */
  layoutProvided: boolean;
  /** FR-033 S3 — document the METAMODEL ITSELF (the built-in type/subtype/attr
   *  vocabulary) instead of a user's entities. Needs NO metadata + NO config. */
  metamodel: boolean;
  /** Emit the browsable HTML documentation site (a `@metaobjectsdev/docs-site`
   *  surface) under `<out>/site`. Additive to the markdown surfaces: when `--site`
   *  is the ONLY surface flag, markdown emission is suppressed; combined with
   *  `--model`/`--api`, both are emitted. */
  site: boolean;
  /** Copy the docs-site templates + assets into codegen/docs-site/ so the consumer owns them. */
  scaffoldSite: boolean;
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
  let prompts: string | undefined;
  let layout: DocsLayout | undefined;
  let baseUrl: string | undefined;
  let wantModel = false;
  let wantApi = false;
  let wantMetamodel = false;
  let wantSite = false;
  let wantScaffoldSite = false;
  let outProvided = false;
  let layoutProvided = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out" || a === "-o") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a directory argument`);
      out = v;
      outProvided = true;
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
      outProvided = true;
    } else if (a === "--layout") {
      layout = parseLayout(argv[++i], a);
      layoutProvided = true;
    } else if (a.startsWith("--layout=")) {
      layout = parseLayout(a.slice("--layout=".length), "--layout");
      layoutProvided = true;
    } else if (a === "--model") {
      wantModel = true;
    } else if (a === "--api") {
      wantApi = true;
    } else if (a === "--metamodel") {
      wantMetamodel = true;
    } else if (a === "--site") {
      wantSite = true;
    } else if (a === "--scaffold-site") {
      wantScaffoldSite = true;
    } else if (a === "--base-url") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a URL argument`);
      baseUrl = v;
    } else if (a.startsWith("--base-url=")) {
      baseUrl = a.slice("--base-url=".length);
    } else if (a === "--templates") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a directory argument`);
      templates = v;
    } else if (a.startsWith("--templates=")) {
      templates = a.slice("--templates=".length);
    } else if (a === "--prompts") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a directory argument`);
      prompts = v;
    } else if (a.startsWith("--prompts=")) {
      prompts = a.slice("--prompts=".length);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (metadata === undefined) {
      metadata = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  // --model and/or --api narrow the MARKDOWN surfaces; both flags (or neither)
  // leave the surfaces unset so the resolved `docs:` config decides (default
  // both). `--site` is a separate (additive) surface: when it is the ONLY
  // surface flag we pass an explicit EMPTY markdown surface list so markdown
  // emission is suppressed (resolveDocsConfig honors `[]` via `??`); combined
  // with --model/--api the requested markdown surfaces still emit alongside it.
  const surfaces: DocsSurface[] = [];
  if (wantModel) surfaces.push("model");
  if (wantApi) surfaces.push("api");
  return {
    // `<metadata>` is the project root that contains metaobjects/; default cwd
    // (mirrors how migrate/gen treat the working directory as the root).
    metadata: metadata ?? cwd,
    // Default out dir, resolved against the metadata root below. In --metamodel
    // mode the renderer writes under <out>/metamodel/, default ./docs/metamodel.
    out: out ?? (wantMetamodel ? "./docs/metamodel" : "./docs"),
    // Default flat preserves today's single-package output (+ existing goldens).
    layout: layout ?? "flat",
    metamodel: wantMetamodel,
    site: wantSite,
    scaffoldSite: wantScaffoldSite,
    outProvided,
    layoutProvided,
    ...(surfaces.length > 0 || wantSite ? { surfaces } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(templates !== undefined ? { templates } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
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

  // FR-033 S3 — `--metamodel`: document the BUILT-IN metamodel (type/subtype/
  // attr vocabulary) from the strict registry. Unlike --model/--api this needs
  // NEITHER a user's metadata NOR a config — there is nothing to load. It writes
  // the renderer's files under <out>/metamodel/ (default ./docs/metamodel).
  if (flags.metamodel) {
    return metamodelDocsCommand(cwd, flags.out);
  }

  const metaRoot = resolvePath(cwd, flags.metadata);
  // Absolute prompt-source dir for the site (--prompts), for a project whose
  // templates live outside metaobjects/ or templates/ (e.g. data/templates/).
  const promptsDir = flags.prompts !== undefined ? resolvePath(cwd, flags.prompts) : undefined;

  // `--scaffold-site`: copy the docs-site templates + assets into codegen/docs-site/
  // so the consumer owns them (ADR-0034 scaffold-and-own). Scaffold and return —
  // it does not also generate. `resolveConfigDir` rather than `resolveCollection`:
  // scaffolding needs no metadata, but it must write where `emitSite` will READ
  // (below, under the resolved project root), and that is the same walk.
  if (flags.scaffoldSite) {
    return scaffoldSiteCommand(await resolveConfigDir(metaRoot));
  }

  // Discovery and load are two separate failure modes, kept in separate try
  // blocks deliberately — same reasoning as `meta gen` (gen.ts): a broad
  // catch around both would swallow a genuine ParseError as "no metaobjects/
  // found", masking the real failure.
  //
  // Discovery runs BEFORE the config read, deliberately, and `meta gen` calls
  // out the same ordering as the thing it fixed: the project root is whichever
  // directory `resolveCollection` decided the metadata belongs to, so
  // everything project-relative — `metaobjects.config.ts` and its providers,
  // the `docs.outDir` it names, the adopter `templates/` overrides, the owned
  // `codegen/docs-site/` theme — has to come from that same directory. Reading
  // the config from the ambient `<metadata>` argument while the metadata came
  // from an ancestor renders the ancestor's model with the subdirectory's
  // (absent) providers. For a run at the project root the two are the same path.
  let collection: Awaited<ReturnType<typeof resolveCollection>>;
  try {
    collection = await resolveCollection(metaRoot);
  } catch (err) {
    log.error(`docs: ${(err as Error).message}`);
    return 2;
  }

  // The project root used to resolve adopter `templates/` overrides; the
  // framework defaults sit underneath via projectProvider's chain. `--templates`
  // is the one explicit override.
  const projectRoot = flags.templates !== undefined
    ? resolvePath(cwd, flags.templates)
    : collection.configDir;

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers (e.g. a project's custom field/object subtypes). Unlike `gen`,
  // docs does NOT require a config — the Tier-2 "metadata alone" promise must
  // hold for config-less projects. If the config is absent or invalid, fall
  // back to defaults; the loader still surfaces a stable unknown-subtype error
  // if the metadata genuinely uses an unregistered type.
  let loadedConfig: Awaited<ReturnType<typeof loadMetaobjectsConfig>> | undefined;
  let configProviders: NonNullable<Awaited<ReturnType<typeof loadMetaobjectsConfig>>["providers"]> | undefined;
  // hasConfig gates the api surface: api docs describe the GENERATED REST
  // surface, which only exists when there is a (loadable) gen config. A config
  // that EXISTS but fails to load degrades to model-only with a warning.
  const hasConfig = existsSync(join(collection.configDir, "metaobjects.config.ts"));
  // The config lives beside the `.metaobjects/` that declared this collection —
  // `collection.configDir`, never ambient cwd. `projectRoot` only diverges from
  // it when --templates overrides the template lookup.
  // Only attempt the load when the file is actually present: absence is the
  // expected config-less case (stay silent), but a config that EXISTS yet fails
  // to load is surfaced as a warning rather than silently degrading to
  // provider-less docs — otherwise a custom-type project would later fail with a
  // cryptic unknown-subtype error instead of the real config error.
  if (hasConfig) {
    try {
      loadedConfig = await loadMetaobjectsConfig(collection.configDir);
      configProviders = loadedConfig.providers;
    } catch (err) {
      log.warn(
        `docs: metaobjects.config.ts failed to load (${(err as Error).message}); ` +
          `generating docs without its providers`,
      );
      loadedConfig = undefined;
      configProviders = undefined;
    }
  }

  // Merge the config `docs:` block with CLI overrides over documented defaults.
  // CLI --out/--layout only override when explicitly passed; surfaces/baseUrl
  // override whenever present. The resolver supplies defaults (outDir ./docs,
  // layout = fallback, surfaces = both) so config-less + flag-less runs are
  // unchanged.
  const cliOverrides: Partial<ResolvedDocsConfig> = {
    ...(flags.outProvided ? { outDir: flags.out } : {}),
    ...(flags.layoutProvided ? { layout: flags.layout } : {}),
    ...(flags.surfaces ? { surfaces: flags.surfaces } : {}),
    ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}),
  };
  // Layout fallback chain: --layout (override, gated above) → docs.layout block →
  // the project's top-level outputLayout → flat. So docs default to the SAME page
  // placement as codegen when neither the docs block nor the CLI sets it.
  const docsCfg = resolveDocsConfig(
    loadedConfig?.docs,
    cliOverrides,
    loadedConfig?.outputLayout ?? "flat",
  );
  const outDir = resolvePath(collection.configDir, docsCfg.outDir);

  // SITE surface has its OWN model loader (docs-site's loadModel — NOT the sdk
  // loadMemory below) and needs no gen config. When the site is the ONLY
  // requested surface (no markdown surfaces resolved), emit it and return
  // WITHOUT building the markdown GenContext — decoupled and one fewer failure
  // surface. Combined with --model/--api it is emitted after them (below).
  if (flags.site && docsCfg.surfaces.length === 0) {
    return emitSite(collection, projectRoot, outDir, configProviders, promptsDir);
  }

  // Load metadata standalone — same loader path as migrate/gen. Threads any
  // consumer providers from the config so custom types resolve.
  let root;
  try {
    root = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(configProviders !== undefined ? { providers: configProviders } : {}),
    });
  } catch (err) {
    log.error(`docs: failed to load metadata: ${(err as Error).message}`);
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
      outputLayout: docsCfg.layout,
      // api-docs reads this to decide whether to document the opt-in Hono CRUD
      // surface. Aggregate it from the generator set exactly as the gen runner
      // does (a generator opts in via emitsHonoRoutes), so `meta docs` auto-detects
      // routesFileHono() rather than relying on a field users don't normally set.
      includeHonoRoutes:
        loadedConfig?.includeHonoRoutes ??
        (loadedConfig?.generators?.some(
          (g) => typeof g !== "string" && g.emitsHonoRoutes === true,
        ) ??
          false),
    } as never,
    renderContext,
    projectRoot,
    warn: (msg) => log.warn(`docs: ${msg}`),
  };

  const emit: EmittedFile[] = [];
  let modelFiles: EmittedFile[] = [];

  // The declared api surfaces, each tagged with its human label (apiLabel maps
  // the language key → label; never hardcode labels). The model page links one
  // reference per declared surface — across ALL ports, not just the surfaces
  // THIS command emits — so a polyglot model page points at every port's docs.
  const labeled = docsCfg.apiSurfaces.map((s) => ({ ...s, label: apiLabel(s.lang) }));

  // The api surface only materializes with a loadable gen config (there is
  // nothing generated to document otherwise), so gate api emit + cross-linking
  // on that. When false, the model surface emits its historical standalone form.
  const apiSelected = docsCfg.surfaces.includes("api") && loadedConfig !== undefined;

  // MODEL surface — the neutral metadata pages (<Entity>.md / <Template>.md +
  // README.md). Keep the render-error handling tight around docsFile() only.
  if (docsCfg.surfaces.includes("model")) {
    // When api is selected, link EVERY declared surface from the model page (so a
    // polyglot model page references each port's api docs). `labeled` already
    // carries {label, subDir, baseUrl?} (docsFile ignores the extra `lang`), so
    // pass it straight through. Otherwise no api refs.
    const modelOpts = apiSelected ? { apiSurfaces: labeled } : {};
    try {
      modelFiles = await docsFile(modelOpts).generate(ctx);
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
    emit.push(...modelFiles);
  }

  // API surface — the SDK reference for the GENERATED REST surface, side by side
  // under each surface's subDir. THIS command only OWNS the surfaces it can
  // generate — i.e. its own port (lang "ts"). Surfaces owned by other ports are
  // linked (above) but produced by running that port's docs command; we just log
  // a pointer. Only meaningful with a loadable gen config, so skip when absent.
  let apiFiles: EmittedFile[] = [];
  if (docsCfg.surfaces.includes("api")) {
    if (loadedConfig !== undefined) {
      try {
        // Emit every surface THIS port owns (loop so it generalizes beyond the
        // single ts surface owned today).
        for (const s of labeled.filter((s) => s.lang === "ts")) {
          apiFiles.push(
            ...(await apiDocsFile({
              subDir: s.subDir,
              modelSurface: docsCfg.surfaces.includes("model"),
            }).generate(ctx)),
          );
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith("docs: duplicate output path")) {
          log.error(msg);
          return 1;
        }
        log.error(`docs: ${msg}`);
        return 1;
      }
      emit.push(...apiFiles);
      // Surfaces owned by other ports: link only, with a pointer to where they
      // get produced.
      for (const s of labeled.filter((s) => s.lang !== "ts")) {
        log.info(
          `meta docs: api surface '${s.lang}' (${s.subDir}) is produced by that port's docs command — run it to populate those pages.`,
        );
      }
    } else if (hasConfig) {
      // Config present but failed to load — already warned above; don't claim an
      // api surface we couldn't build.
      log.info("meta docs: api surface skipped — metaobjects.config.ts failed to load.");
    } else {
      log.info("meta docs: api surface skipped — no metaobjects.config.ts (nothing generated to document).");
    }
  }

  try {
    await mkdir(outDir, { recursive: true });
    for (const f of emit) {
      const path = resolvePath(outDir, f.path);
      await mkdir(resolvePath(path, ".."), { recursive: true });
      await writeFile(path, f.content, "utf8");
    }
  } catch (err) {
    log.error(`docs: failed to write pages: ${(err as Error).message}`);
    return 1;
  }

  // SITE surface (additive) — emit after the markdown surfaces so both coexist.
  if (flags.site) {
    const siteRc = await emitSite(collection, projectRoot, outDir, configProviders, promptsDir);
    if (siteRc !== 0) return siteRc;
  }

  // Summary: docsFile() emits ONE overview/index page (README.md) plus one page
  // per entity and one per template.output. The entity count is the matched
  // object count; the remaining non-overview model pages are template pages.
  const entityCount = root.objects().filter(ctx.matches).length;
  const modelOverview = modelFiles.filter((f) => f.path === "README.md").length;
  const modelTemplates = modelFiles.length > 0
    ? modelFiles.length - entityCount - modelOverview
    : 0;
  const modelSummary = docsCfg.surfaces.includes("model")
    ? `${modelOverview} overview + ${entityCount} entity page(s) + ${modelTemplates} template page(s)`
    : "model surface skipped";
  const apiSummary = apiFiles.length > 0
    ? `${apiFiles.length} api page(s)`
    : "no api pages";
  log.info(`meta docs — wrote ${modelSummary}; ${apiSummary} → ${outDir}`);
  return 0;
}

/**
 * ADR-0034 scaffold-and-own for the docs-site: copy the bundled templates + assets
 * into `<root>/codegen/docs-site/{templates,assets}`, writing each file ONLY if
 * absent so a re-run never clobbers a hand-edited file.
 */
async function scaffoldSiteCommand(projectRoot: string): Promise<number> {
  const tplDir = join(projectRoot, "codegen/docs-site/templates");
  const astDir = join(projectRoot, "codegen/docs-site/assets");
  const created: string[] = [];
  const preserved: string[] = [];
  try {
    await mkdir(tplDir, { recursive: true });
    await mkdir(astDir, { recursive: true });
    for (const name of SITE_TEMPLATE_NAMES) {
      const abs = join(tplDir, name);
      const rel = `codegen/docs-site/templates/${name}`;
      if (existsSync(abs)) { preserved.push(rel); continue; }
      await writeFile(abs, readSiteFile("template", name), "utf8");
      created.push(rel);
    }
    for (const name of SITE_ASSET_NAMES) {
      const abs = join(astDir, name);
      const rel = `codegen/docs-site/assets/${name}`;
      if (existsSync(abs)) { preserved.push(rel); continue; }
      await writeFile(abs, readSiteFile("asset", name), "utf8");
      created.push(rel);
    }
  } catch (err) {
    log.error(`docs: failed to scaffold site templates: ${(err as Error).message}`);
    return 1;
  }
  log.info(
    `meta docs --scaffold-site — ${created.length} created, ${preserved.length} preserved ` +
      `→ ${join(projectRoot, "codegen/docs-site")} (edit these to own your theme)`,
  );
  return 0;
}

/**
 * Distinct directories declared by the collection's source specs, resolved
 * absolute against `collection.configDir`. The site's own loader
 * (`@metaobjectsdev/docs-site`) wants whole directories — each becomes a
 * symlinked, basename-keyed source group — unlike the per-file list
 * `resolveCollection` produces for the sdk `loadMemory` path.
 */
function collectionSourceDirs(collection: Collection): string[] {
  const dirs = new Map<string, string>();
  for (const { spec } of collection.sources) {
    if (!("path" in spec)) continue; // phase 1 resolves "path" specs only
    const key = JSON.stringify(spec);
    if (dirs.has(key)) continue;
    dirs.set(
      key,
      isAbsolute(spec.path) ? spec.path : resolvePath(collection.configDir, spec.path),
    );
  }
  return [...dirs.values()];
}

/**
 * Emit the browsable HTML documentation site via `@metaobjectsdev/docs-site`.
 * The site loads the model with its OWN loader from the resolved metadata
 * source directories (see `resolveCollection`/`collectionSourceDirs`), so
 * this is independent of the sdk loadMemory path used for the markdown
 * surfaces. Writes under `<outDir>/site` so it can coexist with the markdown
 * output. Scaffold-and-own: when the consumer has copied templates/assets
 * into `<projectRoot>/codegen/docs-site/` (via `--scaffold-site`), those win
 * over the bundled defaults.
 *
 * Takes the ALREADY-RESOLVED collection: `docsCommand` resolved it to read the
 * config from the right directory, and resolving a second time here made the
 * combined `--model --site` path do the whole discovery-and-config walk twice.
 */
async function emitSite(
  collection: Collection,
  projectRoot: string,
  outDir: string,
  configProviders?: readonly MetaDataTypeProvider[],
  promptsDir?: string,
): Promise<number> {
  const siteOutDir = resolvePath(outDir, "site");
  // The resolved metadata source dir(s) are REQUIRED (the site loads the
  // model from them) and always first. Prompt `.mustache` source is
  // additionally searched in the conventional <root>/templates/ and any
  // explicit --prompts dir (for a project whose templates live elsewhere,
  // e.g. data/templates/) — else the site can't show the prompt TEXT and
  // prints a "source missing" note. Only existing dirs are added.
  //
  // Deduped by resolved PATH, not by basename. Two DIFFERENT directories that
  // happen to share a basename are a legitimate multi-source project (`metaobjects`
  // plus `../shared-model/metaobjects`); `loadModel` disambiguates their site
  // group names, so refusing the pair here — which a basename key did, by
  // dropping the second — would break the feature this branch exists to ship.
  // The same directory named twice is the real hazard: it would be symlinked
  // and loaded twice.
  const sourceDirs = collectionSourceDirs(collection);
  const seenDirs = new Set(sourceDirs);
  if (promptsDir !== undefined && !existsSync(promptsDir)) {
    log.warn(`docs: --prompts dir does not exist: ${promptsDir}`);
  }
  for (const d of [join(projectRoot, "templates"), ...(promptsDir !== undefined ? [promptsDir] : [])]) {
    const abs = resolvePath(d);
    if (existsSync(abs) && !seenDirs.has(abs)) {
      sourceDirs.push(abs);
      seenDirs.add(abs);
    }
  }
  // Scaffold-and-own: when the consumer has copied templates/assets into
  // codegen/docs-site/ (via --scaffold-site), use those; else the bundled defaults.
  const ownedTemplates = join(projectRoot, "codegen/docs-site/templates");
  const ownedAssets = join(projectRoot, "codegen/docs-site/assets");
  try {
    const r = await generateSite({
      sourceDirs,
      outDir: siteOutDir,
      title: basename(collection.configDir) || "Metadata",
      stamp: new Date().toISOString().slice(0, 10),
      commit: "",
      core: { n: 15 },
      // Thread any consumer providers from metaobjects.config.ts so the site's
      // own loader resolves custom field/view/object subtypes — same providers
      // the markdown surfaces get via loadMemory.
      ...(configProviders !== undefined ? { extraProviders: configProviders } : {}),
      ...(existsSync(ownedTemplates) ? { templatesDir: ownedTemplates } : {}),
      ...(existsSync(ownedAssets) ? { assetsDir: ownedAssets } : {}),
    });
    log.info(`meta docs --site — wrote ${r.pages.length} page(s) → ${siteOutDir}`);
    return 0;
  } catch (err) {
    log.error(`docs: failed to generate site: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * FR-033 S3 — emit the metamodel reference docs (INDEX.md + per-type pages +
 * providers.md) from the BUILT-IN strict registry. No metadata, no config:
 * `composeRegistry(coreProviders)` IS the source. Files land under
 * `<out>` (which defaults to `./docs/metamodel`), preserving the renderer's
 * `types/<family>.md` subtree.
 */
async function metamodelDocsCommand(cwd: string, out: string): Promise<number> {
  const outDir = resolvePath(cwd, out);
  let docs: Map<string, string>;
  try {
    docs = renderCoreMetamodelDocs(composeRegistry(coreProviders));
  } catch (err) {
    log.error(`docs: failed to render metamodel docs: ${(err as Error).message}`);
    return 1;
  }
  try {
    await mkdir(outDir, { recursive: true });
    for (const [rel, content] of docs) {
      const path = resolvePath(outDir, rel);
      await mkdir(resolvePath(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }
  } catch (err) {
    log.error(`docs: failed to write metamodel pages: ${(err as Error).message}`);
    return 1;
  }
  log.info(`meta docs --metamodel — wrote ${docs.size} page(s) → ${outDir}`);
  return 0;
}
