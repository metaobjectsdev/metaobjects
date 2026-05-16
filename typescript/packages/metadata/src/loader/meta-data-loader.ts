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
import { registerCoreTypes } from "../core-types.js";
import {
  TYPE_METADATA, SUBTYPE_ROOT,
  TYPE_OBJECT, TYPE_FIELD, TYPE_LAYOUT, TYPE_IDENTITY, TYPE_ORIGIN, TYPE_RELATIONSHIP,
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
} from "../constants.js";
import { ParseError } from "../errors.js";
import { parseJson } from "../parser-json.js";
import { resolveDeferredSupers } from "../super-resolve.js";
import { validateSubtypeRules } from "../subtype-rules.js";
import { validateAttrSchema } from "../attr-schema-validate.js";
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

function makeSyntheticRoot(): MetaData {
  return new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
}

// ---------------------------------------------------------------------------
// Layout dataGrid @defaultSortField validation
// ---------------------------------------------------------------------------

function validateDataGridSortFields(root: MetaData): ParseError[] {
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

function validateFilterableHasIndex(root: MetaData): string[] {
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

function _findObject(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function _findField(obj: MetaData, name: string): MetaData | undefined {
  // Use effectiveChildren() so inherited fields (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_FIELD && c.name === name);
}

function _findRelationship(obj: MetaData, name: string): MetaData | undefined {
  // Use effectiveChildren() so inherited relationships (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_RELATIONSHIP && c.name === name);
}

function _validateFromPath(
  fromAttr: string,
  root: MetaData,
  projectionName: string,
  fieldName: string,
  errors: ParseError[],
  label: string = "origin.passthrough.@from",
): void {
  const dotIdx = fromAttr.indexOf(".");
  if (dotIdx < 1 || dotIdx === fromAttr.length - 1) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.field".`,
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
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
      ),
    );
    return;
  }
  const sourceField = _findField(sourceObj, targetFieldName);
  if (!sourceField) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such field "${targetFieldName}" on ${entityName}.`,
      ),
    );
  }
}

function _validateViaPath(
  viaAttr: string,
  root: MetaData,
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

function validateOriginPaths(root: MetaData): ParseError[] {
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
          _validateFromPath(of_, root, obj.name, field.name, errors, "origin.aggregate.@of");
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
   * Accessible once load() has completed, in either "loaded" or "error" state.
   * Throws only before or during loading (state "uninitialized" or "loading").
   */
  get root(): MetaData {
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
        `Loader.root accessed before loading has completed (state: "${this._state}"). ` +
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
        "Loader cannot be reused after load completes. Construct a new Loader for additional loads.",
      );
    }

    this._state = "loading";
    const warnings: string[] = [];
    const errors: Error[] = [];

    let root: MetaData | undefined;

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

      if (source.format !== "json") {
        errors.push(
          new Error(`unsupported metadata format "${source.format}" for source "${source.id}"`),
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
