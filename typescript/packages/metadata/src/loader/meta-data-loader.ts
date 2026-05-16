// MetaDataLoader — base loader class with lifecycle skeleton.
//
// Owns the load pipeline contract, lifecycle state, and accessor members.
// The load() body is filled in by Phase 2 Task 3; this file provides
// the skeleton so dependent code can reference MetaDataLoader now.
//
// Java MetaDataLoader lifecycle phases: UNINITIALIZED → LOADING → LOADED → ERROR.
// Reads call _checkStateForRead() to enforce "loaded before read."

import type { MetaData } from "../meta/meta-data.js";
import { MetaRoot } from "../meta/meta-root.js";
import { TypeId, TypeRegistry } from "../registry.js";
import { registerCoreTypes } from "../core-types.js";
import { TYPE_METADATA, SUBTYPE_ROOT } from "../constants.js";
import type { MetaDataSource } from "./meta-data-source.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Loader lifecycle state. Mirrors Java's MetaDataLoader phase enum. */
export type LoadingState = "uninitialized" | "loading" | "loaded" | "error";

export interface LoadOptions {
  /** TypeRegistry to use; defaults to a fresh registry pre-populated via registerCoreTypes(). */
  registry?: TypeRegistry;
  /** Freeze the loaded tree after parsing. Default true. */
  freeze?: boolean;
  /** Strict parsing mode — passed through to parser. Default false. */
  strict?: boolean;
}

export interface LoadResult {
  root: MetaData;
  warnings: string[];
  errors: Error[];
}

// ---------------------------------------------------------------------------
// Synthetic empty root (used when all sources fail to parse)
// ---------------------------------------------------------------------------

export function makeSyntheticRoot(): MetaData {
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
  private _root: MetaData | undefined;

  constructor(opts?: LoadOptions) {
    this._registry = opts?.registry ?? MetaDataLoader._defaultRegistry();
    this._freeze = opts?.freeze !== false; // default true
    this._strict = opts?.strict === true;  // default false
  }

  private static _defaultRegistry(): TypeRegistry {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    return registry;
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
   * pre-populated with core types via registerCoreTypes().
   *
   * Exposed for downstream consumers (codegen, runtime libraries) that
   * need to introspect registered types.
   */
  get registry(): TypeRegistry {
    return this._registry;
  }

  /**
   * Returns the loaded root MetaData.
   * Throws if the loader has not yet completed loading (state != "loaded").
   */
  get root(): MetaData {
    this._checkStateForRead();
    return this._root!;
  }

  private _checkStateForRead(): void {
    if (this._state !== "loaded") {
      throw new Error(
        `Loader.root accessed before loading is complete (state: "${this._state}"). ` +
        `Call load() or loadJsonStrings() first.`,
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
    return this._root!.childByName(name);
  }

  /**
   * Returns the first child of the root with the given (type, name), or undefined.
   * Throws if not yet loaded.
   */
  findByTypeAndName(type: string, name: string): MetaData | undefined {
    this._checkStateForRead();
    return this._root!.childByTypeAndName(type, name);
  }

  /**
   * Returns all direct children of the root with the given type.
   * Throws if not yet loaded.
   */
  childrenOfType(type: string): MetaData[] {
    this._checkStateForRead();
    return this._root!.childrenOfType(type);
  }

  // ---------------------------------------------------------------------------
  // load — placeholder (Phase 2 Task 3 fills in the body)
  // ---------------------------------------------------------------------------

  async load(sources: MetaDataSource[]): Promise<LoadResult> {
    throw new Error("MetaDataLoader.load not implemented — Phase 2 Task 3");
  }
}
