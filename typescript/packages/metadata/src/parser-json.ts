// Canonical JSON parser — redesigned (post-v0.3) format.
//
// Node encoding: every node is a single-key map { "<type>.<subType>": <body> }.
// The wrapper key FUSES type and subType into one dotted token (object.entity,
// field.long, metadata.root). The body is a map of reserved structural keys
// (name/package/extends/abstract/overlay/isArray/children), `@`-prefixed
// attributes, and the children list.
//
// Operator vocabulary (canonical, no aliases):
//   - extends:      string ref to a supertype (immediate resolution against
//                   the accumulating root, or deferred for cross-file refs)
//   - overlay:true  re-opens an existing same-(type,name) child; errors if missing
//
// Default (no operator): silently reuse existing same-(type,name) child, or
// create new.
//
// Context package for super resolution:
//   Each node's effective package is its own package if set, or inherited from
//   the nearest ancestor with a package.

import { TypeId, TypeRegistry } from "./registry.js";
import type { MetaModel } from "./meta/meta-data.js";
import { MetaRoot } from "./meta/meta-root.js";
import { coerceAttrValue } from "./value-coerce.js";
import { ParseError } from "./errors.js";
import { resolveSuperRef } from "./super-resolve.js";
import {
  RESERVED_KEYS,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_OVERLAY,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_VALUE,
  JSON_KEY_SCHEMA,
  ATTR_PREFIX,
  TYPE_SUBTYPE_SEPARATOR,
  TYPE_ATTR,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_VALIDATOR,
  SUBTYPE_BASE,
  PACKAGE_SEPARATOR,
  ATTR_SUBTYPE_STRINGARRAY,
} from "./constants.js";
import type { AttrValue } from "./meta/meta-data.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  registry: TypeRegistry; // required — types must be registered
  strict?: boolean; // throw on parsing problems? default false
  sourceName?: string; // for error messages, e.g., "fishstore.json"
  /**
   * Loader's accumulating root. If provided, parse merges nodes into it.
   * If undefined, creates a new root from the JSON's root node.
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
// Internal helper — split a fused wrapper key into (type, subType).
//
// Canonical JSON always writes the full `type.subType`. An omitted subType
// (a bare `type` key, no `.`) resolves to the type's registry default — the
// first registered subtype, falling back to SUBTYPE_BASE.
// ---------------------------------------------------------------------------

interface SplitKey {
  type: string;
  subType: string;
  /** true when the subType was fused into the key; false when defaulted. */
  explicit: boolean;
}

function defaultSubTypeFor(type: string, registry: TypeRegistry): string {
  const subs = registry.allSubTypesOf(type);
  const candidate = subs.length > 0 ? subs[0]! : SUBTYPE_BASE;
  if (!registry.has(type, candidate) && registry.has(type, SUBTYPE_BASE)) {
    return SUBTYPE_BASE;
  }
  return candidate;
}

function splitTypeKey(key: string, registry: TypeRegistry): SplitKey {
  const dotIdx = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
  if (dotIdx < 0) {
    // Bare type, no fused subType — resolve via the registry default.
    return { type: key, subType: defaultSubTypeFor(key, registry), explicit: false };
  }
  const type = key.slice(0, dotIdx);
  const subType = key.slice(dotIdx + TYPE_SUBTYPE_SEPARATOR.length);
  // Malformed keys (e.g. "object.entity.extra", ".entity", "object.") are not
  // validated here — they fall through to the downstream registry.has() check
  // which reports them as an unknown type or subtype error.
  return { type, subType, explicit: true };
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
 */
function expandPackageForPath(basePkg: string, pkgPath: string): string {
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

  const rootKey = wrapperKeys[0]!;
  const rootData = topLevel[rootKey];

  if (typeof rootData !== "object" || rootData === null || Array.isArray(rootData)) {
    throw new ParseError(
      `Top-level wrapper "${rootKey}" must contain an object`,
      errOpts(source, rootKey),
    );
  }

  const rootDataObj = rootData as Record<string, unknown>;
  const { type: rootType, subType: rootSubType } = splitTypeKey(rootKey, opts.registry);

  // Check root type is registered (always throw — can't skip the root)
  if (!opts.registry.has(rootType, rootSubType)) {
    throw new ParseError(
      `Unknown root type "${rootType}.${rootSubType}" — not registered`,
      errOpts(source, rootKey),
    );
  }

  if (opts.intoRoot !== undefined) {
    // --- Merge mode: parse root's attrs/children into the existing root ---
    // The JSON root's own package/super/reserved-keys are not re-applied to the
    // existing root. BUT: children from the NEW JSON should inherit from the
    // NEW root's package, not the existing root's.
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
      rootKey,
    );
    return { root: opts.intoRoot, warnings, errors };
  }

  // --- Fresh root mode: create a new root from the JSON ---
  const root = parseNodeFresh(
    rootType,
    rootSubType,
    rootDataObj,
    undefined, // no accumulating root yet — built as we go
    "",        // no inherited context pkg yet for the root itself
    opts.registry,
    warnings,
    errors,
    strict,
    source,
    rootKey,
  );
  return { root, warnings, errors };
}

// ---------------------------------------------------------------------------
// parseNodeFresh — creates a NEW node for this metadata node.
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
  subType: string,
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
  // --- Look up type in registry ---
  if (!registry.has(type, subType)) {
    if (registry.has(type, SUBTYPE_BASE)) {
      subType = SUBTYPE_BASE;
    } else {
      const msg = `Unknown type "${type}.${subType}" — not registered`;
      errors.push(new ParseError(msg, errOpts(source, path)));
      const rawName = nodeData[RESERVED_KEY_NAME];
      const name = typeof rawName === "string" ? rawName : "";
      return new MetaRoot(new TypeId(type, subType), name);
    }
  }

  // --- Determine name ---
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // --- Create the model ---
  const def = registry.find(type, subType)!;
  const model = def.factory(def.typeId, name);

  // --- Apply reserved keys (package, extends, abstract, isArray) ---
  applyReservedKeys(model, nodeData, strict, source, path, warnings, inheritedContextPkg);

  // --- Inherit package from context if not explicitly set ---
  // Java rule (BaseMetaDataParser.shouldInheritPackageFromParent):
  // - Fields within objects: no package (simple names)
  // - Fields NOT within objects: inherit parent's package (for abstract fields at root level)
  // - Validators within fields: inherit the field's package ONLY if field's FQN contains "::"
  // - Objects and other types: don't inherit
  if (model.package === undefined && inheritedContextPkg !== "") {
    let shouldInherit = false;

    if (type === TYPE_FIELD && parentType !== TYPE_OBJECT) {
      shouldInherit = true;
    } else if (type === TYPE_VALIDATOR && parentType === TYPE_FIELD && parent !== undefined) {
      shouldInherit = parent.fqn().includes(PACKAGE_SEPARATOR);
    }

    if (shouldInherit) {
      model.setPackage(inheritedContextPkg);
    }
  }

  // --- Determine the effective context package for super resolution ---
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
    reportProblem(
      `super on root node ('${model.superRef}') is not supported and will be ignored`,
      strict,
      warnings,
      source,
      path,
    );
  }

  // --- Process inline attributes and other keys ---
  applyInlineAttrsAndUnknownKeys(model, nodeData, strict, source, path, warnings, registry);

  // --- Process children ---
  // For the root node we use itself as the accumRoot for its children.
  const childAccumRoot = accumRoot ?? model;
  const childInheritedContextPkg = model.package ?? inheritedContextPkg;
  processChildren(model, nodeData, childAccumRoot, childInheritedContextPkg, registry, warnings, errors, strict, source, path);

  return model;
}

// ---------------------------------------------------------------------------
// parseNodeInto — merges a JSON node's attrs/children into an EXISTING model.
//
// Used for the intoRoot mode (top-level merge), overlay: true nodes, and the
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
  applyInlineAttrsAndUnknownKeys(target, nodeData, strict, source, path, warnings, registry);

  // The effective package for children: use inheritedContextPkg (from the new
  // JSON's root) — not target.package, because target is the existing model
  // being merged into, and new children inherit from the NEW context.
  const effectivePkg = inheritedContextPkg;

  processChildren(target, nodeData, accumRoot, effectivePkg, registry, warnings, errors, strict, source, path);
}

// ---------------------------------------------------------------------------
// createOrFindMetaData — per-node merge logic.
//
//   overlay: true → find-or-throw (throw if no existing same-(type,name) child)
//   default       → find-or-create (silently reuse if found)
// ---------------------------------------------------------------------------

function createOrFindMetaData(
  type: string,
  subType: string,
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
  // Only `overlay: true` re-opens an existing node. Anything else falls through
  // to the default reuse-or-create path.
  const isOverlayNode = nodeData[RESERVED_KEY_OVERLAY] === true;

  // Determine name (needed for the lookup). Lookup key is (type, name).
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // Look up an existing child with (type, name). Skip unnamed nodes — they
  // are always distinct (e.g. inline validators, anonymous attrs).
  const existing = name !== "" ? parent.childByTypeAndName(type, name) : undefined;

  if (isOverlayNode) {
    if (existing === undefined) {
      throw new ParseError(
        `Overlay operation requested for [${type}:${name}] but no existing metadata found to merge into`,
        errOpts(source, path),
      );
    }
    existing.setIsMerge(true);
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Default: no operator → silently reuse existing or create new.
  if (existing !== undefined) {
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Not found (or unnamed) → create new
  return parseNodeFresh(type, subType, nodeData, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path, parent.type, parent);
}

// ---------------------------------------------------------------------------
// applyReservedKeys — apply package, extends, abstract, isArray to a model.
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
      const expandedPkg = contextPkg !== undefined ? expandPackageForPath(contextPkg, rawPkg) : rawPkg;
      model.setPackage(expandedPkg);
    }
  }

  // extends — store the raw supertype ref; resolution happens after this call.
  const rawExtends = nodeData[RESERVED_KEY_EXTENDS];
  if (rawExtends !== undefined) {
    if (typeof rawExtends !== "string") {
      reportProblem(`"${RESERVED_KEY_EXTENDS}" must be a string at ${path}`, strict, warnings, source, path);
    } else {
      model.setSuper(rawExtends);
    }
  }

  // abstract — structural key (true → abstract node)
  const rawAbstract = nodeData[RESERVED_KEY_ABSTRACT];
  if (rawAbstract !== undefined) {
    if (typeof rawAbstract !== "boolean") {
      reportProblem(`"${RESERVED_KEY_ABSTRACT}" must be a boolean at ${path}`, strict, warnings, source, path);
    } else {
      model.setIsAbstract(rawAbstract);
    }
  }

  // isArray — structural key (true → array node)
  const rawIsArray = nodeData[RESERVED_KEY_IS_ARRAY];
  if (rawIsArray !== undefined) {
    if (typeof rawIsArray !== "boolean") {
      reportProblem(`"${RESERVED_KEY_IS_ARRAY}" must be a boolean at ${path}`, strict, warnings, source, path);
    } else {
      model.setIsArray(rawIsArray);
    }
  }
}

// ---------------------------------------------------------------------------
// stringArray desugar — normalize a bare-string value for a declared
// stringArray-typed @-attr into a one-element array.
//
// A single string is the degenerate one-element form of a `stringArray` attr
// (every fixture authors `"@fields": "id"`, not `["id"]`). Since the parser is
// registry-aware, it desugars at parse time so that stringArray attrs are
// ALWAYS arrays in the loaded tree. This fixes MetaIdentity.fields /
// MetaRelationship.joinFields (which do `Array.isArray(f) ? f : []` and so
// returned [] for the single-string form) and keeps the canonical serialized
// form consistent.
//
// Only a `string` value is wrapped. Already-array values are left as-is;
// non-string scalars (number/boolean) are left as-is so A3's type validation
// can flag them — the parser does NOT coerce non-strings. Undeclared attrs
// (no matching AttrSchema) are also left as-is.
// ---------------------------------------------------------------------------

function normalizeStringArrayAttr(
  type: string,
  subType: string,
  attrName: string,
  value: AttrValue,
  registry: TypeRegistry,
): AttrValue {
  if (typeof value !== "string") return value;
  const spec = registry.attrsOf(type, subType).find((s) => s.name === attrName);
  if (spec === undefined || spec.valueType !== ATTR_SUBTYPE_STRINGARRAY) return value;
  return [value];
}

// ---------------------------------------------------------------------------
// applyInlineAttrsAndUnknownKeys — apply @-prefixed attrs and warn about unknowns
//
// Called for both fresh creates AND merge-into-existing paths.
// Does NOT process reserved structural keys.
// ---------------------------------------------------------------------------

function applyInlineAttrsAndUnknownKeys(
  model: MetaModel,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
  registry: TypeRegistry,
): void {
  for (const key of Object.keys(nodeData)) {
    // Skip all reserved structural keys (already handled or intentionally ignored)
    if (RESERVED_KEYS.has(key)) continue;

    if (!key.startsWith(ATTR_PREFIX)) {
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
      reportProblem(
        `Failed to coerce attribute "${ATTR_PREFIX}${attrName}" at ${path}: ${(err as Error).message}`,
        strict, warnings, source, path,
      );
      continue;
    }

    // Desugar a bare-string value for a declared stringArray-typed attr.
    const normalized = normalizeStringArrayAttr(
      model.type,
      model.subType,
      attrName,
      coerced.value,
      registry,
    );
    model.setAttr(attrName, normalized);
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

    const childKey = childKeys[0]!;
    const childData = childRecord[childKey];
    const childNodePath = `${childPath}.${childKey}`;

    if (typeof childData !== "object" || childData === null || Array.isArray(childData)) {
      reportProblem(
        `Child wrapper "${childKey}" at ${childNodePath} must contain an object`,
        strict, warnings, source, childNodePath,
      );
      continue;
    }

    const childDataObj = childData as Record<string, unknown>;
    const { type: childType, subType: childSubTypeRaw, explicit } = splitTypeKey(childKey, registry);

    // --- Check if this child type is registered ---
    // An EXPLICIT unknown subType (fused into the key) is an error — never
    // silently downgraded to base. An OMITTED subType that resolves to an
    // unregistered default falls back to base.
    let childSubType = childSubTypeRaw;
    if (!registry.has(childType, childSubType)) {
      if (!explicit && registry.has(childType, SUBTYPE_BASE)) {
        childSubType = SUBTYPE_BASE;
      } else {
        errors.push(
          new ParseError(
            `Unknown type "${childType}.${childSubType}" — not registered`,
            errOpts(source, childNodePath),
          ),
        );
        continue; // skip this child
      }
    }

    // --- Special handling for "attr" child nodes ---
    if (childType === TYPE_ATTR) {
      parseAttrChild(parent, childType, childSubType, childDataObj, registry, warnings, strict, source, childNodePath);
    } else {
      // Use createOrFindMetaData to handle overlay/default per-node logic
      const childModel = createOrFindMetaData(
        childType,
        childSubType,
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
        parent.addChild(childModel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attr child node — dual-storage: structural child + parent.setAttr
// ---------------------------------------------------------------------------
//
// A typed attr is encoded as { "attr.<subType>": { "name": ..., "value": ... } }
// inside a node's children array. The subType is fused into the wrapper key.
//
// The TS port stores BOTH:
//   1. A structural node of type "attr" with the appropriate subType
//   2. The value set on the parent via setAttr(name, coercedValue)

function parseAttrChild(
  parent: MetaModel,
  attrType: string,
  attrSubType: string,
  attrData: Record<string, unknown>,
  registry: TypeRegistry,
  warnings: string[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const attrName = attrData[RESERVED_KEY_NAME];
  const attrValue = attrData[RESERVED_KEY_VALUE];

  if (typeof attrName !== "string" || attrName === "") {
    reportProblem(
      `attr child at ${path} requires a non-empty "${RESERVED_KEY_NAME}" string`,
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
    registry.has(attrType, attrSubType) || !registry.has(attrType, SUBTYPE_BASE)
      ? attrSubType
      : SUBTYPE_BASE;

  const attrDef = registry.find(attrType, resolvedSubType);
  const attrModel = attrDef !== undefined
    ? attrDef.factory(attrDef.typeId, attrName)
    : new MetaRoot(new TypeId(attrType, resolvedSubType), attrName);

  // Desugar a bare-string value for a declared stringArray-typed attr,
  // mirroring the inline @-attr path in applyInlineAttrsAndUnknownKeys.
  const normalized = normalizeStringArrayAttr(
    parent.type,
    parent.subType,
    attrName,
    coercedValue.value,
    registry,
  );

  attrModel.setAttr(RESERVED_KEY_VALUE, coercedValue.value);
  parent.addChild(attrModel);
  parent.setAttr(attrName, normalized);
}
