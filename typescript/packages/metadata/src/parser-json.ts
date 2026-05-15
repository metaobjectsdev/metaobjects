// v0.3 JSON parser — wrapper-keyed format
//
// Operator vocabulary (canonical, no aliases):
//   - extends:    string ref to a supertype (immediate resolution against the accumulating root)
//   - merge:true  merges this node into an existing same-(type,name) child; errors if missing
//
// Default (no operator): silently reuse existing same-(type,name) child, or create new.
//
// Context package for super resolution:
//   Each node's effective package is its own package if set, or inherited from
//   the nearest ancestor with a package.

import { MetaModel } from "./model.js";
import { TypeId, TypeRegistry } from "./registry.js";
import { coerceAttrValue } from "./value-coerce.js";
import { ParseError } from "./errors.js";
import { resolveSuperRef } from "./super-resolve.js";
import {
  RESERVED_KEYS,
  RESERVED_KEY_NAME,
  RESERVED_KEY_SUBTYPE,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_IS_ABSTRACT,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_MERGE,
  RESERVED_KEY_VALUE,
  JSON_KEY_SCHEMA,
  ATTR_PREFIX,
  ATTR_NAME_IS_ARRAY,
  ATTR_NAME_IS_ABSTRACT,
  TYPE_ATTR,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_VALIDATOR,
  SUBTYPE_BASE,
  PACKAGE_SEPARATOR,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  registry: TypeRegistry; // required — types must be registered
  strict?: boolean; // throw on parsing problems? default false
  sourceName?: string; // for error messages, e.g., "fishstore.json"
  /**
   * Loader's accumulating root. If provided, parse merges nodes into it.
   * If undefined, creates a new root MetaModel from the JSON's root node.
   *
   * When provided, the returned `root` is this same instance (possibly mutated).
   * When undefined, a fresh root is created from the JSON.
   */
  intoRoot?: MetaModel;
  /**
   * If true, super refs that don't resolve at parse time are NOT a parse error;
   * the model retains its raw `superRef` and a second pass (via
   * resolveDeferredSupers in super-resolve.ts) is expected after all input
   * files are parsed. Used by Loader.load/loadJsonStrings to support cross-file
   * super resolution where one file may declare a super target that lives in
   * another file parsed later.
   */
  deferSuperResolution?: boolean;
}

export interface ParseResult {
  root: MetaModel;
  warnings: string[];
  errors: ParseError[];
}

// ---------------------------------------------------------------------------
// Internal helper — build ParseError opts, omitting undefined fields
// (required by exactOptionalPropertyTypes: true in the project tsconfig)
// ---------------------------------------------------------------------------

function errOpts(
  source: string | undefined,
  path?: string,
): { source?: string; path?: string } {
  const opts: { source?: string; path?: string } = {};
  if (source !== undefined) opts.source = source;
  if (path !== undefined) opts.path = path;
  return opts;
}

// ---------------------------------------------------------------------------
// Internal helper — report a problem: throw in strict mode, push warning otherwise
// ---------------------------------------------------------------------------

function reportProblem(
  msg: string,
  strict: boolean,
  warnings: string[],
  source: string | undefined,
  path: string,
): void {
  if (strict) throw new ParseError(msg, errOpts(source, path));
  warnings.push(msg);
}

// ---------------------------------------------------------------------------
// Internal helper — resolve a node's subType string with default-and-fallback.
//
// Mirrors Java's behavior: if `subType` is explicitly given in the JSON, use it
// as-is. Otherwise default to the type's first registered subtype (or
// SUBTYPE_BASE if none registered), then fall back to SUBTYPE_BASE if the
// chosen one isn't actually registered.
// ---------------------------------------------------------------------------

function resolveSubType(
  type: string,
  rawSubType: unknown,
  registry: TypeRegistry,
): string {
  if (typeof rawSubType === "string") return rawSubType;
  const subs = registry.allSubTypesOf(type);
  const candidate = subs.length > 0 ? subs[0]! : SUBTYPE_BASE;
  if (!registry.has(type, candidate) && registry.has(type, SUBTYPE_BASE)) {
    return SUBTYPE_BASE;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Helper: expand relative package paths
// ---------------------------------------------------------------------------

/**
 * Expands a package path relative to a base package.
 * Java semantics:
 *   - Absolute path (::foo::bar) → prepended with base: "acme" + "::foo" → "acme::foo::bar"
 *   - Relative parent (..) → handled in super resolution, not here
 *   - No leading :: → used as-is
 *
 * @param basePkg The base package (e.g., "acme" or "acme::common")
 * @param pkgPath The package path from the JSON (e.g., "::garage" or "common")
 * @returns The expanded package path
 */
function expandPackageForPath(basePkg: string, pkgPath: string): string {
  // No base package, or pkgPath isn't an absolute "::"-prefixed path → use as-is.
  if (basePkg.trim() === "" || !pkgPath.startsWith(PACKAGE_SEPARATOR)) {
    return pkgPath;
  }
  return basePkg + pkgPath;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Module-level flag consumed by parseNodeFresh during super resolution.
// Safe because parseJson is fully synchronous — no reentrancy risk within
// a single parse call. Set at parseJson entry, read deep in the call tree.
let _deferSuperResolution = false;

export function parseJson(content: string, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];
  const errors: ParseError[] = [];
  const strict = opts.strict ?? false;
  const source = opts.sourceName;
  _deferSuperResolution = opts.deferSuperResolution === true;

  // --- Strip UTF-8 BOM if present (Java files often have it) ---
  const normalizedContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // --- Parse raw JSON ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (err) {
    throw new ParseError(`Invalid JSON: ${(err as Error).message}`, errOpts(source));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ParseError("Top-level JSON must be an object", errOpts(source));
  }

  const topLevel = parsed as Record<string, unknown>;

  // --- Find the wrapper key (skip $schema) ---
  const wrapperKeys = Object.keys(topLevel).filter((k) => k !== JSON_KEY_SCHEMA);

  if (wrapperKeys.length === 0) {
    throw new ParseError("Top-level JSON object has no type wrapper key", errOpts(source));
  }
  if (wrapperKeys.length > 1) {
    throw new ParseError(
      `Top-level JSON object must have exactly one wrapper key (found: ${wrapperKeys.join(", ")})`,
      errOpts(source),
    );
  }

  const rootType = wrapperKeys[0]!;
  const rootData = topLevel[rootType];

  if (typeof rootData !== "object" || rootData === null || Array.isArray(rootData)) {
    throw new ParseError(
      `Top-level wrapper "${rootType}" must contain an object`,
      errOpts(source, rootType),
    );
  }

  // Check root type is registered (always throw — can't skip the root)
  const rootDataObj = rootData as Record<string, unknown>;
  const rootSubType = resolveSubType(
    rootType,
    rootDataObj[RESERVED_KEY_SUBTYPE],
    opts.registry,
  );
  if (!opts.registry.has(rootType, rootSubType)) {
    throw new ParseError(
      `Unknown root type "${rootType}.${rootSubType}" — not registered`,
      errOpts(source, rootType),
    );
  }

  if (opts.intoRoot !== undefined) {
    // --- Merge mode: parse root's attrs/children into the existing root ---
    // The JSON root's own package/super/reserved-keys are not re-applied to the existing root.
    // BUT: children from the NEW JSON should inherit from the NEW root's package, not the existing root's.
    const newRootPkg = rootDataObj[RESERVED_KEY_PACKAGE];
    const contextPkg = (typeof newRootPkg === "string" ? newRootPkg : opts.intoRoot.package) ?? "";
    parseNodeInto(
      rootDataObj,
      opts.intoRoot,
      opts.intoRoot, // accumulating root for super resolution
      contextPkg,
      opts.registry,
      warnings,
      errors,
      strict,
      source,
      rootType,
    );
    return { root: opts.intoRoot, warnings, errors };
  }

  // --- Fresh root mode: create a new root from the JSON ---
  const root = parseNodeFresh(
    rootType,
    rootDataObj,
    undefined, // no accumulating root yet — built as we go
    "",        // no inherited context pkg yet for the root itself
    opts.registry,
    warnings,
    errors,
    strict,
    source,
    rootType,
  );
  return { root, warnings, errors };
}

// ---------------------------------------------------------------------------
// parseNodeFresh — creates a NEW MetaModel for this node
//
// `accumRoot` is the root of the accumulating tree (for super resolution).
// When parsing the root node itself, accumRoot is undefined on first call;
// the newly created root is passed as accumRoot for its children.
//
// `inheritedContextPkg` is the effective package from the nearest ancestor
// that had an explicit package. Used when this node has no own package.
// ---------------------------------------------------------------------------

function parseNodeFresh(
  type: string,
  nodeData: Record<string, unknown>,
  accumRoot: MetaModel | undefined,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
  parentType?: string, // optional: type of the parent node (for inheritance rules)
  parent?: MetaModel, // optional: the parent model itself (for checking fqn)
): MetaModel {
  // --- Determine subType ---
  const rawSubType = nodeData[RESERVED_KEY_SUBTYPE];
  if (rawSubType !== undefined && typeof rawSubType !== "string") {
    throw new ParseError(
      `"${RESERVED_KEY_SUBTYPE}" must be a string, got ${typeof rawSubType}`,
      errOpts(source, path),
    );
  }
  let subType = resolveSubType(type, rawSubType, registry);

  // --- Look up type in registry ---
  if (!registry.has(type, subType)) {
    if (rawSubType === undefined && registry.has(type, SUBTYPE_BASE)) {
      subType = SUBTYPE_BASE;
    } else {
      const msg = `Unknown type "${type}.${subType}" — not registered`;
      errors.push(new ParseError(msg, errOpts(source, path)));
      const rawName = nodeData[RESERVED_KEY_NAME];
      const name = typeof rawName === "string" ? rawName : "";
      return new MetaModel(new TypeId(type, subType), name);
    }
  }

  // --- Determine name ---
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // --- Create the model ---
  const def = registry.find(type, subType)!;
  const model = def.factory(def.typeId, name);

  // --- Apply reserved keys (package, super, isAbstract) ---
  applyReservedKeys(model, nodeData, strict, source, path, warnings, inheritedContextPkg);

  // --- Inherit package from context if not explicitly set ---
  // Java rule (BaseMetaDataParser.shouldInheritPackageFromParent):
  // - Fields within objects: no package (simple names)
  // - Fields NOT within objects: inherit parent's package (for abstract fields at root level)
  // - Validators within fields: inherit the field's package ONLY if field's FQN contains "::"
  // - Objects and other types: don't inherit
  //
  // The Java code checks parent.fqn().contains(PKG_SEPARATOR) before inheriting a validator.
  // For validators, we check if the parent field has an actual package (fqn contains "::").
  if (model.package === undefined && inheritedContextPkg !== "") {
    let shouldInherit = false;

    if (type === TYPE_FIELD && parentType !== TYPE_OBJECT) {
      // Fields not in objects inherit from their parent
      shouldInherit = true;
    } else if (type === TYPE_VALIDATOR && parentType === TYPE_FIELD && parent !== undefined) {
      // Validators in fields inherit ONLY if field's FQN contains "::"
      // (i.e., the field has an explicit package, not just an inherited context)
      shouldInherit = parent.fqn().includes(PACKAGE_SEPARATOR);
    }

    if (shouldInherit) {
      model.setPackage(inheritedContextPkg);
    }
  }

  // --- Determine the effective context package for super resolution ---
  // Use the node's own package if set; fall back to inherited.
  const effectivePkg = model.package ?? inheritedContextPkg;

  // --- Resolve super IMMEDIATELY against the accumulating root ---
  // (Skipped when deferSuperResolution is true — the loader resolves after
  // all input files have been parsed, so cross-file super refs work.)
  if (model.superRef !== undefined && accumRoot !== undefined && !_deferSuperResolution) {
    const superModel = resolveSuperRef(model.superRef, effectivePkg, accumRoot);
    if (superModel !== undefined) {
      model.setSuperResolved(superModel);
    } else {
      throw new ParseError(
        `the SuperClass '${model.superRef}' does not exist in file '${source ?? "<unknown>"}'`,
        errOpts(source, path),
      );
    }
  } else if (model.superRef !== undefined && accumRoot === undefined) {
    // Root node has a super ref — not resolvable against itself.
    // Warn rather than silently swallow; the user likely made a mistake.
    reportProblem(
      `super on root node ('${model.superRef}') is not supported and will be ignored`,
      strict,
      warnings,
      source,
      path,
    );
  }

  // --- Process inline attributes and other keys ---
  applyInlineAttrsAndUnknownKeys(model, nodeData, strict, source, path, warnings);

  // --- Process children ---
  // For the root node we use itself as the accumRoot for its children.
  const childAccumRoot = accumRoot ?? model;
  // Use the model's actual package (not effective) as the inherited context for children.
  const childInheritedContextPkg = model.package ?? inheritedContextPkg;
  processChildren(model, nodeData, childAccumRoot, childInheritedContextPkg, registry, warnings, errors, strict, source, path);

  return model;
}

// ---------------------------------------------------------------------------
// parseNodeInto — merges a JSON node's attrs/children into an EXISTING model.
//
// Used for the intoRoot mode (top-level merge), merge: true nodes, and the
// default same-name reuse path. Does NOT re-apply reserved keys (subType,
// extends, package) — those belong to the original model's identity.
// ---------------------------------------------------------------------------

function parseNodeInto(
  nodeData: Record<string, unknown>,
  target: MetaModel,
  accumRoot: MetaModel,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  // Apply inline attrs (not reserved keys — those stay on the existing model)
  applyInlineAttrsAndUnknownKeys(target, nodeData, strict, source, path, warnings);

  // The effective package for children: use inheritedContextPkg (from the new JSON's root)
  // Don't use target.package because target is the existing model being merged into,
  // and we want new children to inherit from the NEW context, not the old one.
  const effectivePkg = inheritedContextPkg;

  // Process children
  processChildren(target, nodeData, accumRoot, effectivePkg, registry, warnings, errors, strict, source, path);
}

// ---------------------------------------------------------------------------
// createOrFindMetaData — per-node merge logic.
//
//   merge: true → find-or-throw (throw if no existing same-(type,name) child)
//   default     → find-or-create (silently reuse if found)
// ---------------------------------------------------------------------------

function createOrFindMetaData(
  type: string,
  nodeData: Record<string, unknown>,
  parent: MetaModel,
  accumRoot: MetaModel,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): MetaModel | undefined {
  // v0.3: only `merge: true` is recognized. Anything else falls through to the
  // default reuse-or-create path.
  const isMergeNode = nodeData[RESERVED_KEY_MERGE] === true;

  // Determine name (needed for the lookup). Lookup key is (type, name); the
  // node's subType is read later in parseNodeFresh when creating new models.
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // Look up an existing child with (type, name). Skip unnamed nodes — they
  // are always distinct (e.g. inline validators, anonymous attrs).
  const existing = name !== "" ? parent.childByTypeAndName(type, name) : undefined;

  if (isMergeNode) {
    if (existing === undefined) {
      throw new ParseError(
        `Merge operation requested for [${type}:${name}] but no existing metadata found to merge into`,
        errOpts(source, path),
      );
    }
    existing.setIsMerge(true);
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Default: no operator → silently reuse existing or create new.
  if (existing !== undefined) {
    // Silently reuse existing (merge into it, no warning, no error)
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Not found (or unnamed) → create new
  return parseNodeFresh(type, nodeData, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path, parent.type, parent);
}

// ---------------------------------------------------------------------------
// applyReservedKeys — apply package, super, isAbstract to a model
//
// Called only when CREATING a new model (not when merging into existing).
// ---------------------------------------------------------------------------

function applyReservedKeys(
  model: MetaModel,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
  contextPkg?: string,
): void {
  // package
  const rawPkg = nodeData[RESERVED_KEY_PACKAGE];
  if (rawPkg !== undefined) {
    if (typeof rawPkg !== "string") {
      reportProblem(`"${RESERVED_KEY_PACKAGE}" must be a string at ${path}`, strict, warnings, source, path);
    } else {
      // Expand relative packages against context
      const expandedPkg = contextPkg !== undefined ? expandPackageForPath(contextPkg, rawPkg) : rawPkg;
      model.setPackage(expandedPkg);
    }
  }

  // extends — store the raw supertype ref; resolution happens after this call in parseNodeFresh.
  const rawExtends = nodeData[RESERVED_KEY_EXTENDS];
  if (rawExtends !== undefined) {
    if (typeof rawExtends !== "string") {
      reportProblem(`"${RESERVED_KEY_EXTENDS}" must be a string at ${path}`, strict, warnings, source, path);
    } else {
      model.setSuper(rawExtends);
    }
  }

  // isAbstract — reserved key form
  const rawIsAbstract = nodeData[RESERVED_KEY_IS_ABSTRACT];
  if (rawIsAbstract !== undefined) {
    if (typeof rawIsAbstract !== "boolean") {
      reportProblem(`"${RESERVED_KEY_IS_ABSTRACT}" must be a boolean at ${path}`, strict, warnings, source, path);
    } else {
      model.setIsAbstract(rawIsAbstract);
    }
  }
}

// ---------------------------------------------------------------------------
// applyInlineAttrsAndUnknownKeys — apply @-prefixed attrs and warn about unknowns
//
// Called for both fresh creates AND merge-into-existing paths.
// Does NOT process reserved keys.
// ---------------------------------------------------------------------------

function applyInlineAttrsAndUnknownKeys(
  model: MetaModel,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
): void {
  for (const key of Object.keys(nodeData)) {
    // Skip all reserved keys (already handled or intentionally ignored)
    if (RESERVED_KEYS.has(key)) continue;

    if (key === RESERVED_KEY_CHILDREN) continue; // handled in processChildren

    if (!key.startsWith(ATTR_PREFIX)) {
      // Non-reserved, non-@-prefixed unknown key
      const displayName =
        model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
      reportProblem(
        `Unknown key '${key}' on ${displayName} at ${path} (must be reserved or ${ATTR_PREFIX}-prefixed)`,
        strict, warnings, source, path,
      );
      continue;
    }

    // Inline attribute (@-prefixed)
    const attrName = key.slice(ATTR_PREFIX.length);
    const rawVal = nodeData[key];

    let coerced;
    try {
      coerced = coerceAttrValue(rawVal);
    } catch (err) {
      // Build a context-appropriate failure message matching the original wording.
      const target =
        attrName === ATTR_NAME_IS_ABSTRACT || attrName === ATTR_NAME_IS_ARRAY
          ? `${ATTR_PREFIX}${attrName}`
          : `attribute "${ATTR_PREFIX}${attrName}"`;
      reportProblem(
        `Failed to coerce ${target} at ${path}: ${(err as Error).message}`,
        strict, warnings, source, path,
      );
      continue;
    }

    // Route @isAbstract / @isArray to native flags; everything else is a regular attr.
    if (attrName === ATTR_NAME_IS_ABSTRACT) {
      model.setIsAbstract(coerced.value === true);
    } else if (attrName === ATTR_NAME_IS_ARRAY) {
      model.setIsArray(coerced.value === true);
    } else {
      model.setAttr(attrName, coerced.value);
    }
  }
}

// ---------------------------------------------------------------------------
// processChildren — parse the "children" array of a node
// ---------------------------------------------------------------------------

function processChildren(
  parent: MetaModel,
  nodeData: Record<string, unknown>,
  accumRoot: MetaModel,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const rawChildren = nodeData[RESERVED_KEY_CHILDREN];
  if (rawChildren === undefined) return;

  if (!Array.isArray(rawChildren)) {
    reportProblem(`"${RESERVED_KEY_CHILDREN}" must be an array at ${path}`, strict, warnings, source, path);
    return;
  }

  for (let i = 0; i < rawChildren.length; i++) {
    const childEntry = rawChildren[i];
    const childPath = `${path}.${RESERVED_KEY_CHILDREN}[${i}]`;

    if (typeof childEntry !== "object" || childEntry === null || Array.isArray(childEntry)) {
      reportProblem(`Child at ${childPath} must be an object`, strict, warnings, source, childPath);
      continue;
    }

    const childRecord = childEntry as Record<string, unknown>;
    const childKeys = Object.keys(childRecord);

    if (childKeys.length !== 1) {
      const msg =
        childKeys.length === 0
          ? `Child at ${childPath} has no type wrapper key`
          : `Child at ${childPath} has multiple keys (${childKeys.join(", ")}) — each child must have exactly one wrapper key`;
      reportProblem(msg, strict, warnings, source, childPath);
      continue;
    }

    const childType = childKeys[0]!;
    const childData = childRecord[childType];
    const childNodePath = `${childPath}.${childType}`;

    if (typeof childData !== "object" || childData === null || Array.isArray(childData)) {
      reportProblem(
        `Child wrapper "${childType}" at ${childNodePath} must contain an object`,
        strict, warnings, source, childNodePath,
      );
      continue;
    }

    const childDataObj = childData as Record<string, unknown>;

    // --- Check if this child type is registered ---
    let childSubType = resolveSubType(childType, childDataObj[RESERVED_KEY_SUBTYPE], registry);

    if (!registry.has(childType, childSubType)) {
      if (registry.has(childType, SUBTYPE_BASE)) {
        childSubType = SUBTYPE_BASE;
      } else {
        reportProblem(
          `Unknown child type "${childType}.${childSubType}" at ${childNodePath} — not registered`,
          strict, warnings, source, childNodePath,
        );
        continue; // skip this child
      }
    }

    // --- Special handling for "attr" child nodes ---
    if (childType === TYPE_ATTR) {
      parseAttrChild(parent, childDataObj, registry, warnings, strict, source, childNodePath);
    } else {
      // Use createOrFindMetaData to handle overlay/override/default per-node logic
      const childModel = createOrFindMetaData(
        childType,
        childDataObj,
        parent,
        accumRoot,
        inheritedContextPkg,
        registry,
        warnings,
        errors,
        strict,
        source,
        childNodePath,
      );

      if (childModel !== undefined && !parent.children().includes(childModel)) {
        // New child (not an existing reused one) — add to parent
        parent.addChild(childModel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attr child node — dual-storage: structural child + parent.setAttr
// ---------------------------------------------------------------------------
//
// The Java format uses {"attr": {"name": "isKey", "subType": "boolean", "value": true}}
// inside a node's children array to represent typed attribute values.
//
// The TS port stores BOTH:
//   1. A structural MetaModel child of type "attr" with the appropriate subType
//   2. The value set on the parent via setAttr(name, coercedValue)

function parseAttrChild(
  parent: MetaModel,
  attrData: Record<string, unknown>,
  registry: TypeRegistry,
  warnings: string[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const attrName = attrData[RESERVED_KEY_NAME];
  const attrSubType = attrData[RESERVED_KEY_SUBTYPE];
  const attrValue = attrData[RESERVED_KEY_VALUE];

  if (typeof attrName !== "string" || attrName === "") {
    reportProblem(
      `attr child at ${path} requires a non-empty "${RESERVED_KEY_NAME}" string`,
      strict, warnings, source, path,
    );
    return;
  }

  if (typeof attrSubType !== "string") {
    reportProblem(
      `attr child "${String(attrName)}" at ${path} requires a "${RESERVED_KEY_SUBTYPE}" string`,
      strict, warnings, source, path,
    );
    return;
  }

  if (attrValue === undefined) {
    reportProblem(
      `attr child "${attrName}" at ${path} is missing "${RESERVED_KEY_VALUE}"`,
      strict, warnings, source, path,
    );
    return;
  }

  let coercedValue: ReturnType<typeof coerceAttrValue>;
  try {
    coercedValue = coerceAttrValue(attrValue);
  } catch (err) {
    reportProblem(
      `Failed to coerce attr child "${attrName}" value at ${path}: ${(err as Error).message}`,
      strict, warnings, source, path,
    );
    return;
  }

  // Fall back to base subType if the requested one isn't registered.
  const resolvedSubType =
    registry.has(TYPE_ATTR, attrSubType) || !registry.has(TYPE_ATTR, SUBTYPE_BASE)
      ? attrSubType
      : SUBTYPE_BASE;

  const attrDef = registry.find(TYPE_ATTR, resolvedSubType);
  const attrModel = attrDef !== undefined
    ? attrDef.factory(attrDef.typeId, attrName)
    : new MetaModel(new TypeId(TYPE_ATTR, resolvedSubType), attrName);

  attrModel.setAttr(RESERVED_KEY_VALUE, coercedValue.value);
  parent.addChild(attrModel);
  parent.setAttr(attrName, coercedValue.value);
}
