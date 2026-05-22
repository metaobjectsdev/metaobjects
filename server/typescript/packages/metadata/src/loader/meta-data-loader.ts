// MetaDataLoader — loader with full load pipeline.
//
// Owns the load pipeline contract, lifecycle state, and accessor members.
// The load() method sequences MetaDataSource reads into one accumulating tree,
// using the parser's `intoRoot` param for merge-during-parse.
//
// Java MetaDataLoader lifecycle phases: UNINITIALIZED → LOADING → LOADED → ERROR.
// Reads call _checkStateForRead() to enforce "loaded before read."

import type { MetaData } from "../meta/meta-data.js";
import { MetaRoot } from "../meta/meta-root.js";
import { TypeId, TypeRegistry } from "../registry.js";
import { coreProviders } from "../core-types.js";
import { composeRegistry } from "../provider.js";
import { TYPE_METADATA, SUBTYPE_ROOT } from "../constants.js";
import { ParseError } from "../errors.js";
import { parseJson } from "../parser-json.js";
import { validateDataGridSortFields, validateFilterableHasIndex, validateOriginPaths } from "./validation-passes.js";
import { resolveDeferredSupers } from "../super-resolve.js";
import { validateSubtypeRules } from "../subtype-rules.js";
import { validateAttrSchema } from "../attr-schema-validate.js";
import type { MetaDataSource } from "./meta-data-source.js";
import type { ParseOptions, ParseResult } from "../parser-core.js";

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
  warnings: string[];
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
   * Parse one source's raw content into a ParseResult. The base loader handles
   * JSON only; a non-JSON format throws. Subclasses override this seam to add
   * formats — e.g. FileMetaDataLoader (in @metaobjectsdev/metadata/core) adds YAML.
   * This keeps the browser-safe base loader free of the YAML parser.
   */
  protected parseSource(
    content: string,
    source: MetaDataSource,
    parseOpts: ParseOptions,
  ): ParseResult {
    if (source.format === "json") {
      return parseJson(content, parseOpts);
    }
    throw new Error(
      `MetaDataLoader parses JSON only; format "${source.format}" for source ` +
        `"${source.id}" requires FileMetaDataLoader (from @metaobjectsdev/metadata/core)`,
    );
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
        errors.push(
          new ParseError(
            `the SuperClass '${failure.ref}' does not exist (referenced by ${failure.nodeFqn})`,
            { code: "ERR_UNRESOLVED_SUPER" },
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

      // Sixth pass: origin path validation — validates passthrough.@from,
      // aggregate.@of, and .@via relationship chains.
      errors.push(...validateOriginPaths(root));

      // Seventh pass: attribute-schema validation (Phase A3) — checks each
      // node's @-attributes against its (type, subType) AttrSchema: required
      // attrs present, declared attrs well-typed, allowedValues honored.
      const attrSchemaResult = validateAttrSchema(root, this._registry);
      errors.push(...attrSchemaResult.errors);
      warnings.push(...attrSchemaResult.warnings);
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
    return { root, warnings, errors };
  }
}
