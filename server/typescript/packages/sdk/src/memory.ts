import {
  composeRegistry,
  coreProviders,
  MetaDataLoader,
  type MetaDataTypeProvider,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolveCollection } from "./collection.js";

/**
 * Options for {@link loadMemory}. Consumers can supply additional
 * {@link MetaDataTypeProvider}s to extend the metamodel with their own
 * subtypes/attrs (e.g. a `template.toolcall` subtype).
 */
export interface LoadMemoryOptions {
  /**
   * Consumer-supplied providers. Composed AFTER the default core providers
   * (core-types + db + documentation + forge) unless `replaceDefaults: true`
   * is set. Use this to register additional subtypes or extend existing
   * ones without forking the loader.
   */
  providers?: readonly MetaDataTypeProvider[];
  /**
   * Skip the default core providers; supply your own full set. Advanced —
   * use only when you need to compose a custom metamodel from scratch.
   * Throws if `providers` is absent or empty.
   */
  replaceDefaults?: boolean;
  /**
   * ADR-0023 strict-attr load. When `true`, an authored own `@-attr` matching
   * no registered per-type schema and no commonAttr is `ERR_UNKNOWN_ATTR`.
   * Defaults `false` (legacy open-attr policy) so a downstream app loads lax;
   * the `meta verify` command opts in to `true` (strict-by-default, #96).
   */
  strict?: boolean;
  /**
   * An already-resolved, absolute metadata file list — normally
   * `resolveCollection(...).files`. When supplied, `loadMemory` loads exactly
   * these files and resolves nothing itself.
   *
   * Omitting it is not a different WAY of finding metadata, only a different
   * place the same resolution happens: `loadMemory` then calls
   * `resolveCollection(repoRoot)` itself. Passing it saves the second
   * resolution when the caller already holds a collection (every routed CLI
   * command does) and lets a caller load a file set it computed some other
   * way; it can no longer diverge from what the config declares.
   */
  files?: readonly string[];
  /**
   * MetaObjects-shipped library packages to load ALONGSIDE the project's own files
   * (e.g. `["ai"]` for `metaobjects::ai::LlmCallBase`). Prepended, so an
   * `extends: "metaobjects::ai::LlmCallBase"` in project metadata resolves.
   *
   * Opt-in rather than always-on: a library package registers real top-level nodes, and
   * a project that never references one should not have them appear in its model, its
   * generated output or its docs. Without this the CLI could not load the metadata that
   * shipped generators like `trace-helper` exist to consume, so the generator was
   * reachable from the command line while its input was not (#333).
   */
  libraries?: readonly string[];
}

/** Default provider bundle threaded by {@link loadMemory} when no options
 *  override is supplied. Exposed for tests/inspection; callers shouldn't need
 *  to spread this manually — `loadMemory(root, { providers: [mine] })`
 *  composes `[...defaultLoadMemoryProviders, mine]` automatically.
 *
 *  `coreProviders` and nothing else. `forgeTypesProvider` used to be here, and that
 *  made TypeScript the only port that accepted `@forgeConfidence` and the `decision` /
 *  `principle` / `convention` / `glossary` / `failure` types: no C#, Python, Java or
 *  Kotlin registry registers any of it, and `expected-registry.json` — the manifest all
 *  five ports byte-match — carries none of it either, so the cross-port gate never had
 *  jurisdiction. One document therefore had two verdicts depending on which toolchain
 *  read it, which is the defect the 0.25.0 line was spent on, and 1.0 would have frozen
 *  it. It is registered vocabulary in no port now.
 *
 *  `forgeTypesProvider` is still EXPORTED. A project that wants the vocabulary opts in
 *  the chartered way — `loadMemory(root, { providers: [forgeTypesProvider] })` — which
 *  is ADR-0023's consumer-provider path and carries its own consequences knowingly,
 *  rather than every TypeScript consumer getting it and no other port agreeing. */
export const defaultLoadMemoryProviders: readonly MetaDataTypeProvider[] = [...coreProviders];

/**
 * Load a project's metadata into a single MetaData tree.
 *
 * Which files those are is `resolveCollection`'s decision, never this
 * function's: with no {@link LoadMemoryOptions.files} it calls
 * `resolveCollection(repoRoot)` — nearest-ancestor `.metaobjects/config.json`,
 * then that config's declared `sources`, falling back to the default source
 * directory only when a project declares none. `loadMemory` names no directory
 * of its own, so a caller cannot end up loading from somewhere the rest of the
 * toolchain does not.
 *
 * Excludes `_pending/`. Registers metaobjects core types plus Meta Forge's
 * descriptive top-level types (decision, principle, etc.) so mixed content
 * parses without warnings. Consumer-supplied providers (via
 * {@link LoadMemoryOptions.providers}) are composed AFTER the defaults so
 * they may depend on core/forge ids.
 *
 * Throws `ERR_COLLECTION_NOT_FOUND` when nothing resolves (callers should run
 * `meta init`), unless `options.files` is supplied.
 *
 * @param repoRoot Where resolution STARTS — the working directory, typically
 *   `process.cwd()`. The walk goes up from here for the governing config, so
 *   this need not be the project root itself.
 *   **Ignored entirely when `options.files` is supplied**: that list is already
 *   resolved, so nothing reads this path. Every routed CLI command passes both,
 *   and the argument is inert at all of them.
 * @param options Optional {@link LoadMemoryOptions} — supply additional
 *   providers or replace the default bundle entirely.
 */
export async function loadMemory(
  repoRoot: string,
  options?: LoadMemoryOptions,
): Promise<MetaRoot> {
  const extra = options?.providers ?? [];
  let providers: readonly MetaDataTypeProvider[];
  if (options?.replaceDefaults === true) {
    if (extra.length === 0) {
      throw new Error(
        "loadMemory: `replaceDefaults: true` requires at least one provider in `providers`.",
      );
    }
    providers = extra;
  } else {
    providers = [...defaultLoadMemoryProviders, ...extra];
  }
  const registry = composeRegistry(providers);

  // Both arms are `resolveCollection`'s answer — one already computed by the
  // caller, one computed here. There is no third way to find metadata, and
  // that is the whole of this line's design: the previous no-`files` arm
  // scanned `<repoRoot>/<default dir>` directly, so a caller that copied the
  // routed shape but forgot `files` silently loaded from a directory the
  // project's config may never have mentioned.
  const paths = options?.files !== undefined
    ? [...options.files]
    : [...(await resolveCollection(repoRoot)).files];

  const loader = new MetaDataLoader({
    registry,
    ...(options?.strict === true ? { strict: true } : {}),
  });

  // Library sources are imported lazily and only when asked for — the same reason
  // `MetaDataLoader.fromDirectory` does it. `library-sources.ts` reads `node:fs`, so a
  // static import from a root-reachable module drags Node built-ins into every consumer's
  // graph; that is the #287 bundle defect, and the `./library` subpath exists for exactly
  // the reason `./constants` does. Prepended, so a project's `extends` onto a
  // library-shipped abstract base resolves — super resolution is order-independent, but
  // prepending is the deterministic choice and matches `fromDirectory`.
  const libSources =
    options?.libraries !== undefined && options.libraries.length > 0
      ? (await import("@metaobjectsdev/metadata/library")).librarySources([...options.libraries])
      : [];
  const result = await loader.load([...libSources, ...paths.map((p) => new FileSource(p))]);

  if (result.errors.length > 0) {
    const first = result.errors[0]!;
    throw first;
  }

  return result.root;
}
