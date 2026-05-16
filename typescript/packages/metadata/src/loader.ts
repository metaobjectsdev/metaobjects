// Loader orchestration: parse → freeze
//
// The Loader is the public entry point. It sequences parse calls into one
// accumulating tree, using the parser's `intoRoot` param for merge-during-parse.
//
// Java MetaDataLoader lifecycle phases: UNINITIALIZED → LOADING → LOADED → ERROR.
// Reads call checkState() to enforce "loaded before read."
//
// File reading is Bun-first (Bun.file().text()) with a Node fallback
// (node:fs/promises.readFile). This matches CLAUDE.md: "Bun-first for
// development; Node-compatible for distribution."
//
// Error semantics:
//   - Errors (file-read failures, JSON parse failures) are collected in
//     LoadResult.errors — the Loader never throws from load/loadJsonStrings.
//   - When all files fail to parse, a synthetic empty MetaModel is returned
//     so callers can inspect errors[] and decide how to proceed.
//   - Warnings (unresolvable supers etc.) are collected in LoadResult.warnings.

import { basename, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { MetaModel } from "./meta/meta-data.js";
import { MetaRoot } from "./meta/meta-root.js";
import { TypeId, TypeRegistry } from "./registry.js";
import { registerCoreTypes } from "./core-types.js";
import { parseJson } from "./parser-json.js";
import { resolveDeferredSupers } from "./super-resolve.js";
import { validateSubtypeRules } from "./subtype-rules.js";
import { validateAttrSchema } from "./attr-schema-validate.js";
import { ParseError } from "./errors.js";
import {
  TYPE_METADATA, SUBTYPE_ROOT,
  TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_LAYOUT, TYPE_SOURCE,
  TYPE_ORIGIN, TYPE_RELATIONSHIP,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_DB_INDEXED,
  IDENTITY_ATTR_FIELDS,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  RELATIONSHIP_ATTR_OBJECT_REF,
} from "./constants.js";

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
  root: MetaModel;
  warnings: string[];
  errors: Error[];
}

// ---------------------------------------------------------------------------
// File reader abstraction (Bun-first, Node fallback)
// ---------------------------------------------------------------------------

let _readText: ((path: string) => Promise<string>) | undefined;

async function getReadText(): Promise<(path: string) => Promise<string>> {
  if (_readText !== undefined) return _readText;

  if (typeof Bun !== "undefined") {
    _readText = (p) => Bun.file(p).text();
  } else {
    const { readFile } = await import("node:fs/promises");
    _readText = (p) => readFile(p, "utf-8");
  }
  return _readText;
}

// ---------------------------------------------------------------------------
// Synthetic empty root (used when all sources fail to parse)
// ---------------------------------------------------------------------------

function makeSyntheticRoot(): MetaModel {
  return new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
}

/** Minimal glob matcher supporting `*` (any chars except `/`) and `**` (any chars). */
function matchSimpleGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${regexStr}$`).test(value);
}

// ---------------------------------------------------------------------------
// Layout dataGrid @defaultSortField validation
// ---------------------------------------------------------------------------

function validateDataGridSortFields(root: MetaModel): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use effectiveChildren() so inherited fields (via extends:/super:) are
    // visible when validating @defaultSortField references.
    const effective = obj.effectiveChildren();
    const fieldNames = new Set(
      effective.filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    for (const layout of effective.filter((c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID)) {
      const sortField = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
      if (typeof sortField === "string" && !fieldNames.has(sortField)) {
        errors.push(
          new ParseError(
            `dataGrid layout "${layout.name}" on entity "${obj.name}" has @defaultSortField "${sortField}" ` +
            `but no such field exists on "${obj.name}". Available fields: ${[...fieldNames].join(", ")}`,
          ),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// @filterable without index validation
// ---------------------------------------------------------------------------

function validateFilterableHasIndex(root: MetaModel): string[] {
  const warnings: string[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use effectiveChildren() so inherited fields and identities (via extends:/super:)
    // are included when checking filterable-without-index.
    const effective = obj.effectiveChildren();
    // Build the set of field names that are part of any identity on this object.
    const indexedFieldNames = new Set<string>();
    for (const identity of effective.filter((c) => c.type === TYPE_IDENTITY)) {
      const fields = identity.attr(IDENTITY_ATTR_FIELDS);
      if (typeof fields === "string") {
        for (const name of fields.split(",")) indexedFieldNames.add(name.trim());
      } else if (Array.isArray(fields)) {
        for (const name of fields) if (typeof name === "string") indexedFieldNames.add(name);
      }
    }

    for (const field of effective.filter((c) => c.type === TYPE_FIELD)) {
      const filterable = field.attr(FIELD_ATTR_FILTERABLE);
      if (filterable !== true) continue;
      if (field.attr(FIELD_ATTR_DB_INDEXED) === true) continue;
      if (indexedFieldNames.has(field.name)) continue;
      warnings.push(
        `[filterable-without-index] field "${obj.name}.${field.name}" has @filterable: true but is not ` +
        `part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true ` +
        `to the field (when supported), or remove @filterable: true.`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Origin path validation
//
// Walks every projection's fields, finds `origin` (TYPE_ORIGIN) children,
// and validates:
//   - passthrough.@from resolves to an existing entity + field
//   - aggregate.@of resolves to an existing entity + field
//   - .@via paths resolve through real relationships, hopping entity-by-entity
//     using each relationship's @objectRef
//
// Note: @agg vocabulary is validated by validateAttrSchema (A3 pass) via
// allowedValues on the origin.aggregate @agg attr schema — not here.
// ---------------------------------------------------------------------------

function _findObject(root: MetaModel, name: string): MetaModel | undefined {
  return root.children().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function _findField(obj: MetaModel, name: string): MetaModel | undefined {
  // Use effectiveChildren() so inherited fields (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_FIELD && c.name === name);
}

function _findRelationship(obj: MetaModel, name: string): MetaModel | undefined {
  // Use effectiveChildren() so inherited relationships (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_RELATIONSHIP && c.name === name);
}

function _validateFromPath(
  fromAttr: string,
  root: MetaModel,
  projectionName: string,
  fieldName: string,
  errors: ParseError[],
): void {
  const dotIdx = fromAttr.indexOf(".");
  if (dotIdx < 1 || dotIdx === fromAttr.length - 1) {
    errors.push(
      new ParseError(
        `origin.passthrough.@from "${fromAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.field".`,
      ),
    );
    return;
  }
  const entityName = fromAttr.slice(0, dotIdx);
  const targetFieldName = fromAttr.slice(dotIdx + 1);
  const sourceObj = _findObject(root, entityName);
  if (!sourceObj) {
    errors.push(
      new ParseError(
        `origin.passthrough.@from "${fromAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
      ),
    );
    return;
  }
  const sourceField = _findField(sourceObj, targetFieldName);
  if (!sourceField) {
    errors.push(
      new ParseError(
        `origin.passthrough.@from "${fromAttr}" on ${projectionName}.${fieldName}: no such field "${targetFieldName}" on ${entityName}.`,
      ),
    );
  }
}

function _validateViaPath(
  viaAttr: string,
  root: MetaModel,
  projectionName: string,
  fieldName: string,
  errors: ParseError[],
): void {
  const segments = viaAttr.split(".");
  if (segments.length < 2) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.relationship[.relationship...]".`,
      ),
    );
    return;
  }
  const [entityName, ...relSegments] = segments as [string, ...string[]];
  let currentObj = _findObject(root, entityName);
  if (!currentObj) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
      ),
    );
    return;
  }
  for (const relName of relSegments) {
    const rel = _findRelationship(currentObj, relName);
    if (!rel) {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such relationship "${relName}" on ${currentObj.name}.`,
        ),
      );
      return;
    }
    const refTarget = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
    if (typeof refTarget !== "string" || refTarget === "") {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" on ${currentObj.name} is missing @objectRef.`,
        ),
      );
      return;
    }
    const nextObj = _findObject(root, refTarget);
    if (!nextObj) {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" points to non-existent entity "${refTarget}".`,
        ),
      );
      return;
    }
    currentObj = nextObj;
  }
}

function validateOriginPaths(root: MetaModel): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.children().filter((c) => c.type === TYPE_ORIGIN)) {
        if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
          const from = origin.attr(ORIGIN_PASSTHROUGH_ATTR_FROM);
          if (typeof from !== "string" || from === "") {
            errors.push(
              new ParseError(
                `origin.passthrough on ${obj.name}.${field.name}: missing @from.`,
              ),
            );
            continue;
          }
          _validateFromPath(from, root, obj.name, field.name, errors);
          const via = origin.attr(ORIGIN_PASSTHROUGH_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            _validateViaPath(via, root, obj.name, field.name, errors);
          }
        } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
          const of_ = origin.attr(ORIGIN_AGGREGATE_ATTR_OF);
          if (typeof of_ !== "string" || of_ === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @of.`,
              ),
            );
            continue;
          }
          _validateFromPath(of_, root, obj.name, field.name, errors);
          const via = origin.attr(ORIGIN_AGGREGATE_ATTR_VIA);
          if (typeof via !== "string" || via === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
              ),
            );
            continue;
          }
          _validateViaPath(via, root, obj.name, field.name, errors);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Loader class
// ---------------------------------------------------------------------------

export class Loader {
  private readonly _registry: TypeRegistry;
  private readonly _freeze: boolean;
  private readonly _strict: boolean;

  private _state: LoadingState = "uninitialized";
  private _root: MetaModel | undefined;

  constructor(opts?: LoadOptions) {
    this._registry = opts?.registry ?? Loader._defaultRegistry();
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
   * The TypeRegistry this Loader uses to look up type definitions.
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
   * Returns the loaded root MetaModel.
   * Throws if the loader has not yet completed loading (state != "loaded").
   */
  get root(): MetaModel {
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
  findByName(name: string): MetaModel | undefined {
    this._checkStateForRead();
    return this._root!.childByName(name);
  }

  /**
   * Returns the first child of the root with the given (type, name), or undefined.
   * Throws if not yet loaded.
   */
  findByTypeAndName(type: string, name: string): MetaModel | undefined {
    this._checkStateForRead();
    return this._root!.childByTypeAndName(type, name);
  }

  /**
   * Returns all direct children of the root with the given type.
   * Throws if not yet loaded.
   */
  childrenOfType(type: string): MetaModel[] {
    this._checkStateForRead();
    return this._root!.childrenOfType(type);
  }

  // ---------------------------------------------------------------------------
  // load — file-based entry point
  // ---------------------------------------------------------------------------

  /**
   * Load metadata from one or more file paths. Files are loaded in order;
   * each file is parsed and merged into the accumulating root using the parser's
   * intoRoot mechanism (no separate post-parse merge step).
   *
   * File read failures are collected in errors[] — no throw. If all files fail,
   * a synthetic empty root is returned.
   */
  async load(paths: string[]): Promise<LoadResult> {
    const readText = await getReadText();
    const readErrors: Error[] = [];
    const sources: Array<{ content: string; sourceName?: string }> = [];

    for (const p of paths) {
      try {
        sources.push({ content: await readText(p), sourceName: basename(p) });
      } catch (err) {
        readErrors.push(
          err instanceof Error
            ? err
            : new Error(`Failed to read file "${p}": ${String(err)}`),
        );
      }
    }

    // Always route through loadJsonStrings — even with an empty list — so
    // loader state transitions correctly when every file fails to read.
    const result = this.loadJsonStrings(sources);
    result.errors = [...readErrors, ...result.errors];
    return result;
  }

  // ---------------------------------------------------------------------------
  // loadJson — single-string convenience
  // ---------------------------------------------------------------------------

  /**
   * Load metadata from a single JSON string (no file IO). Useful for tests
   * and inline usage.
   */
  loadJson(content: string, sourceName?: string): LoadResult {
    const source: { content: string; sourceName?: string } = { content };
    if (sourceName !== undefined) source.sourceName = sourceName;
    return this.loadJsonStrings([source]);
  }

  // ---------------------------------------------------------------------------
  // loadFromDirectory — directory-scan convenience
  // ---------------------------------------------------------------------------

  /**
   * Load all `.json` files in a directory (non-recursive). Convenience wrapper
   * over load(paths[]) — used by @metaobjects/sdk's loadMemory() and any other
   * caller that wants "everything in this dir".
   *
   * @param dir Absolute or relative directory path.
   * @param opts.exclude Array of glob patterns (relative to dir) to skip.
   *   Supports simple `*` (any chars except `/`) and `**` (any chars) matching.
   */
  async loadFromDirectory(
    dir: string,
    opts?: { exclude?: string[] },
  ): Promise<LoadResult> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      return {
        root: makeSyntheticRoot(),
        warnings: [],
        errors: [new Error(`loadFromDirectory: cannot read ${dir}: ${(err as Error).message}`)],
      };
    }

    const excludes = opts?.exclude ?? [];
    const paths: string[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(dir, entry);
      const statResult = await stat(filePath);
      if (!statResult.isFile()) continue;
      if (excludes.some((pattern) => matchSimpleGlob(pattern, entry))) continue;
      paths.push(filePath);
    }

    if (paths.length === 0) {
      return { root: makeSyntheticRoot(), warnings: [], errors: [] };
    }

    return this.load(paths);
  }

  // ---------------------------------------------------------------------------
  // loadJsonStrings — core pipeline
  // ---------------------------------------------------------------------------

  /**
   * Load multiple JSON strings. Each source is parsed and merged into the
   * accumulating root using the parser's `intoRoot` mechanism.
   *
   * Pipeline:
   *   1. Parse first source → creates the root MetaModel.
   *   2. Parse each subsequent source with `intoRoot` = existing root
   *      → parser merges nodes (respecting per-node merge/default logic)
   *      and resolves supers immediately against the accumulating root.
   *   3. Freeze (unless freeze: false).
   *
   * Parse errors are collected in errors[] — parsing continues with the next source.
   */
  loadJsonStrings(sources: Array<{ content: string; sourceName?: string }>): LoadResult {
    // Disallow re-use after a completed load (matches Java MetaDataLoader's
    // INITIALIZED-once contract). Loader is a one-shot pipeline.
    if (this._state === "loaded" || this._state === "error") {
      throw new Error(
        "Loader cannot be reused after load completes. Construct a new Loader for additional loads.",
      );
    }

    this._state = "loading";
    const warnings: string[] = [];
    const errors: Error[] = [];

    let root: MetaModel | undefined;

    // Parse all files with super resolution DEFERRED so cross-file super
    // refs work — one file may declare a super target that's defined in a
    // file parsed later. A second pass (resolveDeferredSupers) resolves
    // everything against the fully-merged root.
    for (const { content, sourceName } of sources) {
      // Build parser options, honoring exactOptionalPropertyTypes — only include
      // sourceName / intoRoot keys when defined.
      const parseOpts: Parameters<typeof parseJson>[1] = {
        registry: this._registry,
        strict: this._strict,
        deferSuperResolution: true,
      };
      if (sourceName !== undefined) parseOpts.sourceName = sourceName;
      if (root !== undefined) parseOpts.intoRoot = root;

      try {
        // After the first successful parse, root is established.
        // Subsequent parses with intoRoot return the same root instance.
        // (parseJson handles BOM stripping internally.)
        const parseResult = parseJson(content, parseOpts);
        warnings.push(...parseResult.warnings);
        errors.push(...parseResult.errors);
        root = parseResult.root;
      } catch (err) {
        errors.push(
          err instanceof Error
            ? err
            : new Error(`Parse error in "${sourceName ?? "<unknown>"}": ${String(err)}`),
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
    // always get a valid MetaModel. The state captures whether errors occurred.
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
