// Shared canonical tree-builder — redesigned (post-v0.3) format.
//
// buildTree() turns a canonical-shaped JS object into a typed MetaData tree.
// parser-json.ts and parser-yaml.ts both funnel their parsed/desugared input
// through here so JSON and YAML stay isomorphic ("one structure, two
// renderings").
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
import type { MetaData } from "./shared/meta-data.js";
import { MetaRoot } from "./shared/meta-root.js";
import { MetaAttr } from "./core/attr/meta-attr.js";
import { inferAttrSubType } from "./serializer-json.js";
import { ParseError, type ErrorCode } from "./errors.js";
import type { ErrorSource } from "./source.js";
import { resolveSuperRef } from "./super-resolve.js";
import { JsonPathBuilder } from "./json-path.js";
import {
  TYPE_ATTR,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_VALIDATOR,
  SUBTYPE_BASE,
} from "./shared/base-types.js";
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
  PACKAGE_SEPARATOR,
} from "./shared/structural.js";
import { ATTR_SUBTYPE_PROPERTIES } from "./core/attr/attr-constants.js";
import type { AttrValue } from "./shared/meta-data.js";

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
  intoRoot?: MetaRoot;
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
  root: MetaRoot;
  warnings: string[];
  errors: ParseError[];
}

// ---------------------------------------------------------------------------
// Internal helper — build a parse-phase ErrorSource envelope.
//
// FR5a / ADR-0009: ParseError carries a `source: ErrorSource` envelope. For
// errors raised mid-parse, the envelope's jsonPath comes from the parser's
// module-level JsonPathBuilder (synced with the walk); files[0] is the parsed
// source id. Falls back to a code-source envelope if invoked outside a buildTree
// run (defensive — every callsite below runs inside buildTree).
// ---------------------------------------------------------------------------

export function errSource(): ErrorSource {
  if (_currentPath !== undefined && _currentSourceId !== undefined) {
    return {
      format: "json",
      files: [_currentSourceId],
      jsonPath: _currentPath.toString(),
    };
  }
  return { format: "code", caller: "parser-core" };
}

// ---------------------------------------------------------------------------
// Internal helper — report a problem: throw in strict mode, push warning otherwise
// ---------------------------------------------------------------------------

function reportProblem(
  msg: string,
  strict: boolean,
  warnings: string[],
  code: ErrorCode,
): void {
  if (strict) {
    throw new ParseError(msg, { code, source: errSource() });
  }
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
// Safe because buildTree is fully synchronous — no reentrancy risk within
// a single parse call. Set at buildTree entry, read deep in the call tree.
let _deferSuperResolution = false;

// Module-level hard-error sink for inline @-attr checks (used by
// applyInlineAttrsAndUnknownKeys). Set at buildTree entry alongside the
// errors[] aggregator so a reserved-word-as-attr violation lands in the
// loader's errors[] without changing the helper's signature.
// Safe because buildTree is synchronous — same reentrancy argument as
// _deferSuperResolution.
let _currentErrors: ParseError[] | undefined;

// FR5a / ADR-0009 — Module-level JSONPath builder + source id, set at
// buildTree entry and updated by recursive descent (push on the way down,
// pop on the way back up). Used by populateNodeSource() to stamp every
// constructed MetaData with `{ format: "json", files: [sourceId], jsonPath }`.
// Safe because buildTree is synchronous — same reentrancy argument as
// _currentErrors above.
let _currentPath: JsonPathBuilder | undefined;
let _currentSourceId: string | undefined;

/** Set the parsed-from-JSON provenance envelope on a freshly-created node.
 *  No-op when the parser is invoked outside buildTree's setup (defensive — the
 *  module-level state will always be populated during a normal parse). */
function populateNodeSource(node: MetaData): void {
  if (_currentPath === undefined || _currentSourceId === undefined) return;
  node.setSource({
    format: "json",
    files: [_currentSourceId],
    jsonPath: _currentPath.toString(),
  });
}

/**
 * buildTree — the shared registry-driven tree-builder.
 *
 * Turns an already-parsed *canonical-shaped* JS object (from JSON.parse, or
 * from the YAML parser's desugar) into a typed MetaData tree. Both parseJson
 * and parseYaml funnel through here, guaranteeing one structure / two
 * renderings stay isomorphic.
 *
 * Throws ParseError for top-level structural problems (matching the historical
 * parseJson behavior); collects content-level problems into the result.
 */
export function buildTree(parsed: unknown, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];
  const errors: ParseError[] = [];
  const strict = opts.strict ?? false;
  const source = opts.sourceName;
  _deferSuperResolution = opts.deferSuperResolution === true;
  _currentErrors = errors;
  // FR5a — start a fresh JSONPath stack rooted at "$"; sourceId is the
  // source's id (from FileSource / InMemoryStringSource via opts.sourceName).
  // Falls back to "<unknown>" when no name was supplied (e.g. ad-hoc parseJson
  // calls from tests).
  _currentPath = new JsonPathBuilder();
  _currentSourceId = source ?? "<unknown>";

  try {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ParseError("Top-level metadata must be an object", { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() });
    }

    const topLevel = parsed as Record<string, unknown>;

    // --- Find the wrapper key (skip $schema) ---
    const wrapperKeys = Object.keys(topLevel).filter((k) => k !== JSON_KEY_SCHEMA);

    if (wrapperKeys.length === 0) {
      throw new ParseError("Top-level metadata object has no type wrapper key", { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() });
    }
    if (wrapperKeys.length > 1) {
      throw new ParseError(
        `Top-level metadata object must have exactly one wrapper key (found: ${wrapperKeys.join(", ")})`,
        { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() },
      );
    }

    const rootKey = wrapperKeys[0]!;
    const rootData = topLevel[rootKey];

    if (typeof rootData !== "object" || rootData === null || Array.isArray(rootData)) {
      // The error context references the rootKey wrapper; push it so the
      // envelope's jsonPath includes it (matches the legacy `path` slot).
      _currentPath!.pushKey(rootKey);
      const src = errSource();
      _currentPath!.pop();
      throw new ParseError(
        `Top-level wrapper "${rootKey}" must contain an object`,
        { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: src },
      );
    }

    const rootDataObj = rootData as Record<string, unknown>;
    const { type: rootType, subType: rootSubType } = splitTypeKey(rootKey, opts.registry);

    // Check root type is registered (always throw — can't skip the root)
    if (!opts.registry.has(rootType, rootSubType)) {
      const rootTypeCode = opts.registry.allSubTypesOf(rootType).length > 0
        ? "ERR_UNKNOWN_SUBTYPE" as const
        : "ERR_UNKNOWN_TYPE" as const;
      _currentPath!.pushKey(rootKey);
      const src = errSource();
      _currentPath!.pop();
      throw new ParseError(
        `Unknown root type "${rootType}.${rootSubType}" — not registered`,
        { code: rootTypeCode, source: src },
      );
    }

    // FR5a — push the wrapper-key segment onto the JSONPath stack so all
    // descendants emit jsonPath strings rooted at "$.<rootKey>". The merge-mode
    // path keeps the existing root's source untouched; only NEW children get
    // populated with the current source's id (correct: the existing root was
    // already stamped from the file that created it).
    _currentPath!.pushKey(rootKey);

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
      _currentPath!.pop();
      return { root: opts.intoRoot, warnings, errors };
    }

    // --- Fresh root mode: create a new root from the JSON ---
    // The cast is safe within the core provider: `metadata.root` is the only
    // registered `metadata` subtype, and its factory unconditionally produces a
    // MetaRoot (see core-types.ts). A registry that registered a second
    // `metadata.*` subtype backed by a non-MetaRoot factory would break this
    // cast — a known limitation of the `TypeDefinition.factory: => MetaData`
    // signature. `parseNodeFresh` is a general node parser, so MetaData is its
    // correct return type; this top-level callsite is where the doc-root invariant holds.
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
    ) as MetaRoot;
    _currentPath!.pop();
    return { root, warnings, errors };
  } finally {
    _deferSuperResolution = false;
    _currentErrors = undefined;
    _currentPath = undefined;
    _currentSourceId = undefined;
  }
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
  accumRoot: MetaData | undefined,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
  parentType?: string, // optional: type of the parent node (for inheritance rules)
  parent?: MetaData, // optional: the parent model itself (for checking fqn)
): MetaData {
  // --- Look up type in registry ---
  if (!registry.has(type, subType)) {
    if (registry.has(type, SUBTYPE_BASE)) {
      subType = SUBTYPE_BASE;
    } else {
      const msg = `Unknown type "${type}.${subType}" — not registered`;
      errors.push(new ParseError(msg, { code: "ERR_UNKNOWN_TYPE", source: errSource() }));
      const rawName = nodeData[RESERVED_KEY_NAME];
      const name = typeof rawName === "string" ? rawName : "";
      const stub = new MetaRoot(new TypeId(type, subType), name);
      populateNodeSource(stub);
      return stub;
    }
  }

  // --- Determine name ---
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // --- Create the model ---
  const def = registry.find(type, subType)!;
  const model = def.factory(def.typeId, name);
  // FR5a — stamp the source provenance envelope using the parser's current
  // JSONPath stack + source id. setSource happens BEFORE freeze (the parser
  // is the only caller during loading; freeze runs in the loader after).
  populateNodeSource(model);

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
        { code: "ERR_UNRESOLVED_SUPER", source: errSource() },
      );
    }
  } else if (model.superRef !== undefined && accumRoot === undefined) {
    // Root node has a super ref — not resolvable against itself.
    reportProblem(
      `super on root node ('${model.superRef}') is not supported and will be ignored`,
      strict,
      warnings,
      "ERR_UNRESOLVED_SUPER",
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
  target: MetaData,
  accumRoot: MetaData,
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
  parent: MetaData,
  accumRoot: MetaData,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): MetaData | undefined {
  // Only `overlay: true` re-opens an existing node. Anything else falls through
  // to the default reuse-or-create path.
  const isOverlayNode = nodeData[RESERVED_KEY_OVERLAY] === true;

  // Determine name (needed for the lookup). Lookup key is (type, name).
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // Look up an existing child with (type, name). Skip unnamed nodes — they
  // are always distinct (e.g. inline validators, anonymous attrs).
  const existing = name !== "" ? parent.ownChildByTypeAndName(type, name) : undefined;

  if (isOverlayNode) {
    if (existing === undefined) {
      throw new ParseError(
        `Overlay operation requested for [${type}:${name}] but no existing metadata found to merge into`,
        { code: "ERR_OVERLAY_NO_TARGET", source: errSource() },
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
  model: MetaData,
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
      reportProblem(`"${RESERVED_KEY_PACKAGE}" must be a string at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      const expandedPkg = contextPkg !== undefined ? expandPackageForPath(contextPkg, rawPkg) : rawPkg;
      model.setPackage(expandedPkg);
    }
  }

  // extends — store the raw supertype ref; resolution happens after this call.
  const rawExtends = nodeData[RESERVED_KEY_EXTENDS];
  if (rawExtends !== undefined) {
    if (typeof rawExtends !== "string") {
      reportProblem(`"${RESERVED_KEY_EXTENDS}" must be a string at ${path}`, strict, warnings, "ERR_UNRESOLVED_SUPER");
    } else {
      model.setSuper(rawExtends);
    }
  }

  // abstract — structural key (true → abstract node)
  const rawAbstract = nodeData[RESERVED_KEY_ABSTRACT];
  if (rawAbstract !== undefined) {
    if (typeof rawAbstract !== "boolean") {
      reportProblem(`"${RESERVED_KEY_ABSTRACT}" must be a boolean at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      model.setIsAbstract(rawAbstract);
    }
  }

  // isArray — structural key (true → array node)
  const rawIsArray = nodeData[RESERVED_KEY_IS_ARRAY];
  if (rawIsArray !== undefined) {
    if (typeof rawIsArray !== "boolean") {
      reportProblem(`"${RESERVED_KEY_IS_ARRAY}" must be a boolean at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      model.setIsArray(rawIsArray);
    }
  }
}

// ---------------------------------------------------------------------------
// applyInlineAttrsAndUnknownKeys — apply @-prefixed attrs and warn about unknowns
//
// Called for both fresh creates AND merge-into-existing paths.
// Does NOT process reserved structural keys.
// ---------------------------------------------------------------------------

function applyInlineAttrsAndUnknownKeys(
  model: MetaData,
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
        strict, warnings, "ERR_UNKNOWN_ATTR",
      );
      continue;
    }

    // Inline attribute (@-prefixed) — materialize into a MetaAttr instance.
    const attrName = key.slice(ATTR_PREFIX.length);

    // Reserved structural keys (name/package/extends/abstract/overlay/isArray
    // /children/value) must NOT be @-prefixed — they're written bare. An
    // @-prefixed reserved word is always a metadata-author error (e.g.
    // "@isArray" instead of bare "isArray") and is reported as a hard error
    // regardless of strict mode so downstream code never sees a bogus
    // MetaAttr named after a reserved word.
    if (RESERVED_KEYS.has(attrName)) {
      const displayName =
        model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
      const msg =
        `Reserved structural key '${attrName}' must not be ${ATTR_PREFIX}-prefixed ` +
        `on ${displayName} at ${path} (write it bare)`;
      if (strict) {
        throw new ParseError(msg, { code: "ERR_RESERVED_ATTR", source: errSource() });
      }
      // Lax mode: route through the module-level errors sink so the loader
      // sees this as a hard error (parity with attr-schema-validate's
      // ERR_BAD_ATTR_VALUE direct pushes). Falls back to warnings only if
      // _currentErrors isn't bound (unreachable when called from buildTree).
      if (_currentErrors !== undefined) {
        _currentErrors.push(new ParseError(msg, { code: "ERR_RESERVED_ATTR", source: errSource() }));
      } else {
        warnings.push(msg);
      }
      continue;
    }

    const rawVal = nodeData[key];

    try {
      const attr = materializeAttr(model, attrName, rawVal, registry);
      model.setMetaAttr(attr);
    } catch (err) {
      reportProblem(
        `Failed to convert attribute "${ATTR_PREFIX}${attrName}" at ${path}: ${(err as Error).message}`,
        strict, warnings, "ERR_BAD_ATTR_VALUE",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// materializeAttr — build a single attr into the right MetaAttr subclass:
// declared subtype from the owner's AttrSchema (if any), else inferred from the
// value shape. The instance coerces + desugars its own value.
// ---------------------------------------------------------------------------

function materializeAttr(
  owner: MetaData,
  attrName: string,
  rawVal: unknown,
  registry: TypeRegistry,
): MetaAttr {
  // Resolve attr spec: per-type attrs take precedence over common attrs.
  // Common attrs are consulted as a fallback so they get the correct MetaAttr
  // subclass (and thus the right coerce/validateValue) at parse time.
  const perTypeSpec = registry.attrsOf(owner.type, owner.subType).find((s) => s.name === attrName);
  const attrSpec = perTypeSpec ?? registry.getCommonAttrs().find((s) => s.name === attrName);
  let subType: string;
  if (attrSpec !== undefined && attrSpec.valueType !== undefined) {
    subType = attrSpec.valueType;
  } else {
    // Undeclared or declared-but-untyped (@default): preserve the author's shape.
    subType = inferUndeclaredAttrSubType(rawVal);
  }
  const def = registry.find(TYPE_ATTR, subType);
  const node = (def !== undefined
    ? def.factory(def.typeId, attrName)
    : new MetaAttr(new TypeId(TYPE_ATTR, subType), attrName)) as MetaAttr;
  const coerced = node.coerce(rawVal);
  const desugared = node.desugar(coerced);
  node.setAttr(RESERVED_KEY_VALUE, desugared);
  return node;
}

// Undeclared attr → pick the subtype from the value's runtime shape, preserving
// type (a numeric string stays string). Wraps inferAttrSubType (scalar/array
// rule, incl. the int/long/double range split) with the object + null-reject
// branches that predate object attrs: a plain object → properties; null /
// undefined are not valid undeclared attr values.
function inferUndeclaredAttrSubType(raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new Error(`${raw === null ? "null" : "undefined"} is not a valid attr value`);
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return ATTR_SUBTYPE_PROPERTIES;
  return inferAttrSubType(raw as AttrValue);
}

// ---------------------------------------------------------------------------
// processChildren — parse the "children" array of a node
// ---------------------------------------------------------------------------

function processChildren(
  parent: MetaData,
  nodeData: Record<string, unknown>,
  accumRoot: MetaData,
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
    reportProblem(`"${RESERVED_KEY_CHILDREN}" must be an array at ${path}`, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
    return;
  }

  // FR5a — push the "children" segment once; each iteration pushes/pops a
  // numeric index + the wrapper-key segment so nested nodes see the correct
  // jsonPath when populateNodeSource() is called during their construction.
  _currentPath?.pushKey(RESERVED_KEY_CHILDREN);

  for (let i = 0; i < rawChildren.length; i++) {
    const childEntry = rawChildren[i];
    const childPath = `${path}.${RESERVED_KEY_CHILDREN}[${i}]`;
    _currentPath?.pushIndex(i);

    if (typeof childEntry !== "object" || childEntry === null || Array.isArray(childEntry)) {
      reportProblem(`Child at ${childPath} must be an object`, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
      _currentPath?.pop();
      continue;
    }

    const childRecord = childEntry as Record<string, unknown>;
    const childKeys = Object.keys(childRecord);

    if (childKeys.length !== 1) {
      const msg =
        childKeys.length === 0
          ? `Child at ${childPath} has no type wrapper key`
          : `Child at ${childPath} has multiple keys (${childKeys.join(", ")}) — each child must have exactly one wrapper key`;
      reportProblem(msg, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
      _currentPath?.pop();
      continue;
    }

    const childKey = childKeys[0]!;
    const childData = childRecord[childKey];
    const childNodePath = `${childPath}.${childKey}`;
    _currentPath?.pushKey(childKey);

    if (typeof childData !== "object" || childData === null || Array.isArray(childData)) {
      reportProblem(
        `Child wrapper "${childKey}" at ${childNodePath} must contain an object`,
        strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT",
      );
      _currentPath?.pop(); // pop child wrapper key
      _currentPath?.pop(); // pop array index
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
        const childTypeCode = explicit && registry.allSubTypesOf(childType).length > 0
          ? "ERR_UNKNOWN_SUBTYPE" as const
          : "ERR_UNKNOWN_TYPE" as const;
        errors.push(
          new ParseError(
            `Unknown type "${childType}.${childSubType}" — not registered`,
            { code: childTypeCode, source: errSource() },
          ),
        );
        _currentPath?.pop(); // pop child wrapper key
        _currentPath?.pop(); // pop array index
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

      if (childModel !== undefined && !parent.ownChildren().includes(childModel)) {
        parent.addChild(childModel);
      }
    }
    _currentPath?.pop(); // pop child wrapper key
    _currentPath?.pop(); // pop array index
  }
  _currentPath?.pop(); // pop the "children" key
}

// ---------------------------------------------------------------------------
// Attr child node — materialize into a MetaAttr instance (NOT a child).
// ---------------------------------------------------------------------------
//
// A typed attr is encoded as { "attr.<subType>": { "name": ..., "value": ... } }
// inside a node's children array. The subType is fused into the wrapper key.
//
// The instance coerces + desugars toward its OWN subtype (the wrapper key's
// subType, e.g. attr.stringarray) — StringArrayAttr.coerce wraps the bare
// string, FilterAttr.desugar normalizes. The attr is attached via setMetaAttr,
// never addChild: attrs are no longer structural children (D2/D5).

function parseAttrChild(
  parent: MetaData,
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
      strict, warnings, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }

  if (attrValue === undefined) {
    reportProblem(
      `attr child "${attrName}" at ${path} is missing "${RESERVED_KEY_VALUE}"`,
      strict, warnings, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }

  // Resolve the attr node's own subtype (fall back to base if unregistered).
  const resolvedSubType =
    registry.has(attrType, attrSubType) || !registry.has(attrType, SUBTYPE_BASE)
      ? attrSubType
      : SUBTYPE_BASE;
  const attrDef = registry.find(attrType, resolvedSubType);

  const node = (attrDef !== undefined
    ? attrDef.factory(attrDef.typeId, attrName)
    : new MetaAttr(new TypeId(attrType, resolvedSubType), attrName)) as MetaAttr;

  try {
    const coerced = node.coerce(attrValue);
    const desugared = node.desugar(coerced);
    node.setAttr(RESERVED_KEY_VALUE, desugared);
  } catch (err) {
    reportProblem(
      `Failed to convert attr child "${attrName}" value at ${path}: ${(err as Error).message}`,
      strict, warnings, "ERR_BAD_ATTR_VALUE",
    );
    return;
  }

  parent.setMetaAttr(node);
}
