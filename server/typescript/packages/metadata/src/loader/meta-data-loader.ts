// MetaDataLoader — loader with full load pipeline.
//
// Owns the load pipeline contract, lifecycle state, and accessor members.
// The load() method sequences MetaDataSource reads into one accumulating tree,
// using the parser's `intoRoot` param for merge-during-parse.
//
// Java MetaDataLoader lifecycle phases: UNINITIALIZED → LOADING → LOADED → ERROR.
// Reads call _checkStateForRead() to enforce "loaded before read."

import type { MetaData } from "../shared/meta-data.js";
import { MetaRoot } from "../shared/meta-root.js";
import { TypeId, TypeRegistry } from "../registry.js";
import { coreProviders } from "../core-types.js";
import { composeRegistry } from "../provider.js";
import { TYPE_METADATA, SUBTYPE_ROOT } from "../shared/base-types.js";
import { ParseError } from "../errors.js";
import type { LoaderWarning } from "../source.js";
import { codeSource, resolvedSource } from "../source.js";
import { parseJson } from "../parser-json.js";
import { validateDataGridSortFields, validateFilterableHasIndex, validateFilterableHasSupportedOps, validateOriginPaths, validateDataGridFilterValues, validateFieldObjectStorage, validateTemplatePayloadRefs, validateFieldDefaults, validateRelationships } from "./validation-passes.js";
import { validateSourceRoles } from "../persistence/source/validate-source-roles.js";
import { validateSourcePhysicalNames } from "../persistence/source/validate-source-physical-names.js";
import { validateSourceParameterRef } from "../persistence/source/validate-source-parameter-ref.js";
import { validateFieldReadOnly } from "../core/field/validate-field-readonly.js";
import { validateDiscriminator } from "../core/object/validate-discriminator.js";
import { resolveDeferredSupers } from "../super-resolve.js";
import { validateSubtypeRules } from "../subtype-rules.js";
import { validateAttrSchema } from "../attr-schema-validate.js";
import type { MetaDataFormat, MetaDataSource } from "./meta-data-source.js";
import { InMemoryStringSource } from "./meta-data-source.js";
import type { ParseOptions, ParseResult } from "../parser-core.js";

// Local mirror of DirectorySource's options shape. Deliberately inlined here
// (instead of `import type`'d from ./sources/directory-source.js) so the
// browser-safety crawler — which walks every `import|export from` it sees,
// type-only or not — never follows a path into a node:fs-using file.
// Keep field-for-field in sync with `DirectoryOptions` in `./sources/directory-source.ts`.
export type DirectoryFactoryOptions = {
  exclude?: string[];
  recurse?: boolean;
  /**
   * Opt-in library packages to prepend before the directory's own sources.
   * Library sources are prepended so `extends` references to library-shipped
   * abstract bases are resolvable from app metadata files.
   *
   * Example: `{ libraries: ["ai"] }` prepends the `metaobjects::ai` library
   * (LlmCallBase etc.) so app entities may use `extends: "metaobjects::ai::LlmCallBase"`.
   */
  libraries?: string[];
};

// YAML parser and node:fs-backed Source impls are loaded lazily (dynamic
// import) inside the methods that need them. Reason: the package root
// (src/index.ts) re-exports MetaDataLoader and must stay browser-safe —
// the browser-safety test asserts that no file reachable from index.ts
// statically imports `yaml` or `node:fs(/promises)`.

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Loader lifecycle state. Mirrors Java's MetaDataLoader phase enum. */
export type LoadingState = "uninitialized" | "loading" | "loaded" | "error";

export interface LoadOptions {
  /** TypeRegistry to use; defaults to a fresh registry pre-populated via composeRegistry(coreProviders). */
  registry?: TypeRegistry;
  /** Freeze the loaded tree after parsing. Default true. */
  freeze?: boolean;
  /** Strict parsing mode — passed through to parser. Default false. */
  strict?: boolean;
}

export interface LoadResult {
  root: MetaRoot;
  /** Cross-port-aligned warning envelopes per ADR-0009.
   *  FR5a creates the channel; FR5c (overlay-merge duplicate detection)
   *  will be the first feature to populate it. Legacy string warnings
   *  collected during parse/validation are wrapped at the loader boundary
   *  with `code: "WARN_LEGACY"` and `source: { format: "code" }` so the
   *  channel always presents the envelope shape to consumers. */
  warnings: LoaderWarning[];
  errors: Error[];
}

// ---------------------------------------------------------------------------
// Synthetic empty root (used when all sources fail to parse)
// ---------------------------------------------------------------------------

function makeSyntheticRoot(): MetaRoot {
  return new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
}

// ---------------------------------------------------------------------------
// MetaDataLoader class
// ---------------------------------------------------------------------------

export class MetaDataLoader {
  private readonly _registry: TypeRegistry;
  private readonly _freeze: boolean;
  private readonly _strict: boolean;

  private _state: LoadingState = "uninitialized";
  private _root: MetaRoot | undefined;

  constructor(opts?: LoadOptions) {
    this._registry = opts?.registry ?? MetaDataLoader._defaultRegistry();
    this._freeze = opts?.freeze !== false; // default true
    this._strict = opts?.strict === true;  // default false
  }

  private static _defaultRegistry(): TypeRegistry {
    return composeRegistry(coreProviders);
  }

  // ---------------------------------------------------------------------------
  // Static factories — the 99% case (cross-language consistent)
  // ---------------------------------------------------------------------------

  /**
   * Load every supported file (`.json` / `.yaml` / `.yml`) under `dir` in
   * deterministic ordinal-basename order. Recurses by default.
   *
   * Convenience for the typical "load a directory of metadata" path. The
   * `DirectorySource` impl is loaded lazily to keep the package root
   * browser-safe (the underlying source uses node:fs).
   *
   * A missing/unreadable directory is surfaced as a collected entry in
   * `result.errors`; the loader returns a synthetic empty root rather than
   * throwing — preserves the `meta export` CLI exit-code contract.
   */
  static async fromDirectory(
    dir: string,
    opts?: DirectoryFactoryOptions & LoadOptions,
  ): Promise<LoadResult> {
    const { exclude, recurse, libraries, ...loaderOpts } = opts ?? {};
    // Conditional spreads honor exactOptionalPropertyTypes — only forward keys
    // when the caller supplied a value, so DirectorySource's own defaults apply.
    const dirOpts: DirectoryFactoryOptions = {
      ...(exclude !== undefined && { exclude }),
      ...(recurse !== undefined && { recurse }),
    };
    const { DirectorySource } = await import("./sources/directory-source.js");
    const loader = new MetaDataLoader(loaderOpts);
    try {
      const dirSources = await new DirectorySource(dir, dirOpts).expand();
      // Library sources are loaded lazily and conditionally to keep the import
      // path away from the browser-safe entry (library-sources.ts uses node:fs)
      // and to avoid the import cost when no libraries are requested.
      let libSources: MetaDataSource[] = [];
      if (libraries?.length) {
        const { librarySources } = await import("../library/library-sources.js");
        libSources = librarySources(libraries);
      }
      // Prepend library sources so `extends` refs to library-shipped abstract
      // bases are resolvable when the merged root is built. Super resolution is
      // deferred (order-independent), but prepending is the deterministic choice.
      return loader.load([...libSources, ...dirSources]);
    } catch (err) {
      // Match the pre-unification contract: a missing/unreadable directory is
      // surfaced as a collected error on the LoadResult, not a throw. The
      // pipeline still completes with a synthetic empty root.
      const emptyResult = await loader.load([]);
      const expandErr =
        err instanceof Error
          ? err
          : new Error(`MetaDataLoader.fromDirectory: ${String(err)}`);
      return { ...emptyResult, errors: [expandErr, ...emptyResult.errors] };
    }
  }

  /**
   * Load each URI as a {@link UriSource}. Supports `file://`, `http://`,
   * `https://` schemes. The source impl is loaded lazily to keep the package
   * root browser-safe.
   */
  static async fromUris(uris: string[], opts?: LoadOptions): Promise<LoadResult> {
    const { UriSource } = await import("./sources/uri-source.js");
    const sources = uris.map((u) => new UriSource(u));
    return new MetaDataLoader(opts).load(sources);
  }

  /** Load a single in-memory string of the given format. */
  static async fromString(
    content: string,
    format: MetaDataFormat,
    opts?: LoadOptions,
  ): Promise<LoadResult> {
    return new MetaDataLoader(opts).load([new InMemoryStringSource(content, { format })]);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Current loading state. */
  get state(): LoadingState {
    return this._state;
  }

  /**
   * The TypeRegistry this MetaDataLoader uses to look up type definitions.
   * Either the one passed in via constructor, or the default registry
   * pre-populated with core types via composeRegistry(coreProviders).
   *
   * Exposed for downstream consumers (codegen, runtime libraries) that
   * need to introspect registered types.
   */
  get registry(): TypeRegistry {
    return this._registry;
  }

  /**
   * Returns the loaded root MetaRoot.
   * Accessible once load() has completed, in either "loaded" or "error" state.
   * Throws only before or during loading (state "uninitialized" or "loading").
   */
  get root(): MetaRoot {
    this._checkStateForRead();
    return this._root!;
  }

  /**
   * Guards read accessors — throws only when loading has not yet completed
   * (state "uninitialized" or "loading"). Both "loaded" and "error" states
   * are valid for reads: load() always sets _root before returning.
   */
  private _checkStateForRead(): void {
    if (this._state === "uninitialized" || this._state === "loading") {
      throw new Error(
        `MetaDataLoader.root accessed before loading has completed (state: "${this._state}"). ` +
        `Call load() first.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience accessors (mirror Java's MetaDataLoader getChildOfType etc.)
  // ---------------------------------------------------------------------------

  /**
   * Returns the first child of the root with the given name, or undefined.
   * Throws if not yet loaded.
   */
  findByName(name: string): MetaData | undefined {
    this._checkStateForRead();
    return this._root!.ownChildByName(name);
  }

  /**
   * Returns the first child of the root with the given (type, name), or undefined.
   * Throws if not yet loaded.
   */
  findByTypeAndName(type: string, name: string): MetaData | undefined {
    this._checkStateForRead();
    return this._root!.ownChildByTypeAndName(type, name);
  }

  /**
   * Returns all direct children of the root with the given type.
   * Throws if not yet loaded.
   */
  childrenOfType(type: string): MetaData[] {
    this._checkStateForRead();
    return this._root!.ownChildrenOfType(type);
  }

  // ---------------------------------------------------------------------------
  // parseSource — overridable format dispatch seam
  // ---------------------------------------------------------------------------

  /**
   * Parse one source's raw content into a ParseResult. Dispatches on the
   * source's declared `format` — `"json"` runs the canonical JSON parser,
   * `"yaml"` desugars the authoring YAML into canonical JSON via parseYaml.
   * Cross-language consistent: the same format vocabulary is honored by the
   * Java / C# / Python MetaDataLoaders.
   *
   * The YAML parser is loaded lazily so the browser-safe root entry never
   * statically pulls in the `yaml` dependency — see the module-header comment.
   * `parseYaml` is preloaded inside `load()` if any source declares YAML
   * format so the call here can stay synchronous.
   */
  protected parseSource(
    content: string,
    source: MetaDataSource,
    parseOpts: ParseOptions,
  ): ParseResult {
    if (source.format === "json") {
      return parseJson(content, parseOpts);
    }
    if (source.format === "yaml") {
      const fn = MetaDataLoader._yamlParser;
      if (fn === undefined) {
        throw new Error(
          `MetaDataLoader: YAML parser was not preloaded — this is an internal bug. ` +
            `Source "${source.id}" declares format "yaml".`,
        );
      }
      return fn(content, parseOpts);
    }
    throw new Error(
      `MetaDataLoader: unsupported source format "${source.format}" ` +
        `on source "${source.id}"`,
    );
  }

  // Cached lazy YAML parser — populated by _ensureYamlParser() before
  // parseSource is invoked on a YAML source. Module-level cache (one import
  // per process) keeps the per-load cost negligible.
  private static _yamlParser:
    | ((content: string, opts: ParseOptions) => ParseResult)
    | undefined;

  private static async _ensureYamlParser(): Promise<void> {
    if (MetaDataLoader._yamlParser !== undefined) return;
    const mod = await import("../core/parser-yaml.js");
    MetaDataLoader._yamlParser = mod.parseYaml;
  }

  // ---------------------------------------------------------------------------
  // load — async pipeline over MetaDataSource[]
  // ---------------------------------------------------------------------------

  /**
   * Load metadata from one or more MetaDataSource instances. Sources are read
   * in order; each source's content is parsed and merged into the accumulating
   * root using the parser's `intoRoot` mechanism.
   *
   * Source read failures are collected in errors[] — no throw. If all sources
   * fail (read or parse), a synthetic empty root is returned.
   *
   * This is a one-shot pipeline — calling load() again on the same loader
   * after it has completed (state "loaded" or "error") throws.
   */
  async load(sources: MetaDataSource[]): Promise<LoadResult> {
    // Disallow re-use after a completed load (matches Java MetaDataLoader's
    // INITIALIZED-once contract). Loader is a one-shot pipeline.
    if (this._state === "loaded" || this._state === "error") {
      throw new Error(
        "MetaDataLoader cannot be reused after load completes. Construct a new MetaDataLoader for additional loads.",
      );
    }

    this._state = "loading";
    const warnings: string[] = [];
    const errors: Error[] = [];
    // FR5c — envelope-shaped warnings (WARN_DUPLICATE_DECLARATION et al.)
    // surface here untouched. Distinct from the legacy `warnings: string[]`
    // channel: those are wrapped in a WARN_LEGACY envelope at the boundary,
    // while these already carry their own code + source.
    const envelopeWarnings: LoaderWarning[] = [];

    // Pre-load the YAML parser via dynamic import if any source declares
    // YAML format. This keeps `parseSource` synchronous and the package root
    // (src/index.ts) browser-safe — yaml is never statically imported from a
    // file reachable from the package entry. See `_ensureYamlParser`.
    if (sources.some((s) => s.format === "yaml")) {
      await MetaDataLoader._ensureYamlParser();
    }

    let root: MetaRoot | undefined;

    // Parse all sources with super resolution DEFERRED so cross-file super
    // refs work — one source may declare a super target that's defined in a
    // source parsed later. A second pass (resolveDeferredSupers) resolves
    // everything against the fully-merged root.
    for (const source of sources) {
      let content: string;
      try {
        content = await source.read();
      } catch (err) {
        errors.push(
          err instanceof Error
            ? err
            : new Error(`Failed to read source "${source.id}": ${String(err)}`),
        );
        continue;
      }

      // Build parser options, honoring exactOptionalPropertyTypes — only include
      // sourceName / intoRoot keys when defined.
      const parseOpts: Parameters<typeof parseJson>[1] = {
        registry: this._registry,
        strict: this._strict,
        deferSuperResolution: true,
        sourceName: source.id,
      };
      if (root !== undefined) parseOpts.intoRoot = root;

      try {
        const parseResult = this.parseSource(content, source, parseOpts);
        warnings.push(...parseResult.warnings);
        errors.push(...parseResult.errors);
        // FR5c — collect envelope-shaped warnings (already carry code +
        // source). The legacy `warnings` channel still flows into the
        // WARN_LEGACY-wrapping path below for unchanged behavior.
        envelopeWarnings.push(...parseResult.envelopeWarnings);
        root = parseResult.root;
      } catch (err) {
        errors.push(
          err instanceof Error
            ? err
            : new Error(`Parse error in "${source.id}": ${String(err)}`),
        );
      }
    }

    // Second pass: resolve every deferred super ref against the full tree.
    // Unresolved refs are always errors (matches the original eager-throw
    // behavior — broken metadata is broken regardless of strict mode).
    if (root !== undefined) {
      const failures = resolveDeferredSupers(root);
      for (const failure of failures) {
        // FR5d — emit format=resolved with referrer + target. The referrer's
        // parse-time source supplies files + jsonPath (the location of the
        // broken `extends:` on disk); referrer = the declaring node's FQN;
        // target = the unresolved supertype ref.
        if (failure.kind === "target-mismatch") {
          // FR-024 — a dotted child-targeting ref resolved, but the target's
          // type/subtype differs from the extending node's. Dotted-only check.
          const r = failure.referrer;
          const t = failure.target;
          errors.push(
            new ParseError(
              `the extends target '${failure.ref}' is ${t?.type}.${t?.subType} but the extending node '${failure.nodeFqn}' is ${r?.type}.${r?.subType} — a dotted extends must target a node of the same type and subtype`,
              {
                code: "ERR_EXTENDS_TARGET_MISMATCH",
                source: resolvedSource(failure.source, failure.nodeFqn, failure.ref),
              },
            ),
          );
          continue;
        }
        errors.push(
          new ParseError(
            `the SuperClass '${failure.ref}' does not exist (referenced by ${failure.nodeFqn})`,
            {
              code: "ERR_UNRESOLVED_SUPER",
              source: resolvedSource(failure.source, failure.nodeFqn, failure.ref),
            },
          ),
        );
      }

      // Third pass: subtype rule validation (entity should have primary identity,
      // value must not have one).
      const ruleResult = validateSubtypeRules(root);
      errors.push(...ruleResult.errors);
      warnings.push(...ruleResult.warnings);

      // Fourth pass: data-grid @defaultSortField cross-reference validation.
      errors.push(...validateDataGridSortFields(root));

      // Fifth pass: @filterable without index drift warning.
      warnings.push(...validateFilterableHasIndex(root));

      // SP-H Unit9 — @filterable on a subtype with no operator band → error
      // (would silently generate a filter that rejects every request).
      errors.push(...validateFilterableHasSupportedOps(root));

      // Sixth pass: origin path validation — validates passthrough.@from,
      // aggregate.@of, and .@via relationship chains.
      errors.push(...validateOriginPaths(root));

      // Seventh pass: @filter value validation — fields filterable + ops allowed per subtype.
      errors.push(...validateDataGridFilterValues(root));

      // FR-017 — M:N relationship validation (deferred-resolution): @through names a
      // junction declaring two identity.reference children; @sourceRefField matches one;
      // @symmetric is self-join-only + mutually exclusive with @sourceRefField; M:N attrs
      // are invalid on a 1:N relationship.
      errors.push(...validateRelationships(root));

      // template.* validation — @payloadRef resolves to a known object;
      // @requiredSlots are real fields on it (FR-004 Plan #3, T2).
      errors.push(...validateTemplatePayloadRefs(root));

      // Eighth pass: attribute-schema validation (Phase A3) — checks each
      // node's @-attributes against its (type, subType) AttrSchema: required
      // attrs present, declared attrs well-typed, allowedValues honored.
      const attrSchemaResult = validateAttrSchema(root, this._registry, this._strict);
      errors.push(...attrSchemaResult.errors);
      warnings.push(...attrSchemaResult.warnings);

      // Ninth pass: @storage cross-attribute validation — @storage requires
      // @objectRef, and @storage "flattened" forbids isArray=true.
      errors.push(...validateFieldObjectStorage(root));

      // Tenth pass: one-primary multi-source rule — if an object has ≥1 source,
      // exactly one must carry role "primary" (ERR_SOURCE_NO_PRIMARY /
      // ERR_SOURCE_MULTIPLE_PRIMARY).
      errors.push(...validateSourceRoles(root));

      // FR-016 / ADR-0018 — per-kind physical-name alias validation on
      // source.rdb (kind-matching alias, no multiples, legacy @table warning).
      const physicalNameResult = validateSourcePhysicalNames(root);
      errors.push(...physicalNameResult.errors);
      envelopeWarnings.push(...physicalNameResult.warnings);

      // FR-013 — field-level @readOnly cross-attribute rules
      // (ERR_READONLY_DOWNGRADE / ERR_READONLY_ASSIGNED_PRIMARY /
      // WARN_READONLY_VALUE_OBJECT).
      const readOnlyResult = validateFieldReadOnly(root);
      errors.push(...readOnlyResult.errors);
      envelopeWarnings.push(...readOnlyResult.warnings);

      // FR-015 — source.rdb @parameterRef typed-input validation.
      errors.push(...validateSourceParameterRef(root));

      // FR-014 — TPH discriminator (@discriminator / @discriminatorValue)
      // cross-attribute validation.
      errors.push(...validateDiscriminator(root));

      // Eleventh pass: per-type @default coercibility — a field's @default value
      // must coerce to the field's type (int/long → integer, double/float/decimal →
      // finite number, boolean → true|false). Enum @default membership is validated
      // by validateAttrSchema (Check 5). Cross-port parity with Java/Python/C#.
      errors.push(...validateFieldDefaults(root));
    }

    // If nothing parsed successfully, synthesize an empty root so callers
    // always get a valid MetaData. The state captures whether errors occurred.
    if (root === undefined) {
      root = makeSyntheticRoot();
      this._state = errors.length > 0 ? "error" : "loaded";
    } else {
      this._state = "loaded";
    }

    // Freeze applies to BOTH paths — synthetic-root callers shouldn't get a
    // mutable model just because their inputs failed.
    if (this._freeze) {
      root.freeze();
    }

    this._root = root;
    // Wrap legacy string warnings collected from parser-core / validators in
    // LoaderWarning envelopes at the loader boundary. The parser/validator
    // surface keeps its `string[]` shape internally (parser-core is shared
    // with parseJson() / parseYaml() callers who consume string warnings
    // directly). FR5c-onward sites emit proper envelopes via parseResult.
    // envelopeWarnings (collected above) — those surface unchanged.
    const wrappedLegacy: LoaderWarning[] = warnings.map((msg) => ({
      code: "WARN_LEGACY",
      message: msg,
      source: codeSource("MetaDataLoader"),
    }));
    return {
      root,
      warnings: [...envelopeWarnings, ...wrappedLegacy],
      errors,
    };
  }
}
