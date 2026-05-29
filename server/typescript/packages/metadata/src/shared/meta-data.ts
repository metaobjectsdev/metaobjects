import { TypeId } from "../registry.js";
import { TYPE_ATTR } from "./base-types.js";
import { PACKAGE_SEPARATOR, RESERVED_KEY_VALUE } from "./structural.js";
import type { DataType } from "../data-type.js";
import type { MetaAttr } from "../core/attr/meta-attr.js";
import { inferAttrSubType } from "../serializer-json.js";
import { attrClassFor } from "../attr-class-map.js";
import type { ErrorSource } from "../source.js";

export type AttrValue = string | number | boolean | string[] | AttrObject;

/**
 * Object-shaped attr value (for `attr.filter` / `attr.properties`). Values are
 * arbitrary JSON so a filter can hold nested `{ op: value }` clauses (including
 * scalar arrays for `in` and `null` for `isNull`). Scalar/string[] attrs keep
 * their existing arms — this arm is reached only by object-typed attr subtypes.
 */
export type AttrObject = { readonly [key: string]: AttrJson };
export type AttrJson = string | number | boolean | null | AttrJson[] | AttrObject;

export abstract class MetaData {
  readonly typeId: TypeId;
  readonly name: string;

  // Identity / packaging
  package?: string;
  // Resolution-only: the file-default package (the top-level `metadata.package`)
  // of the FILE in which this node was declared, captured at PARSE time. This is
  // NOT folded into fqn() (object fqn() stays BARE for the FR5d cross-port
  // referrer-envelope contract) — it exists solely so super-resolution can match
  // a node by its EFFECTIVE qualified key `<fileDefaultPackage>::<name>` even
  // when the node carries no own `package`. Capturing it at parse time (when the
  // declaring file's package is known) makes resolution independent of load
  // order and post-merge tree shape. Mirrors Java's BaseMetaDataParser, which
  // folds getDefaultPackageName() into the registered name at parse time.
  fileDefaultPackage?: string;
  superRef?: string;         // raw super reference string, pre-resolution
  private _superData?: MetaData; // post-resolution pointer; set by setSuperResolved() after parsing
  isAbstract: boolean = false;

  // Native @isArray (boolean property, NOT in attrs!)
  isArray: boolean = false;

  /**
   * Per-node merge flag (v0.3 `merge: true` operator).
   *
   * When `true` on a node being parsed:
   *   - If an existing same-(type,name) child is found in the current parent → reuse it (merge into it).
   *   - If NOT found → throw: "Merge operation requested for [...] but no existing metadata found".
   */
  isMerge: boolean = false;

  // Internal storage — attributes as MetaAttr instances, name-indexed and
  // insertion-ordered. NOT in _children (attrs never appear in ownChildren()).
  private _attrNodes = new Map<string, MetaAttr>();
  // A MetaAttr's own scalar/array/object value is a terminal stored under the
  // reserved "value" key. It is NOT materialized as a nested MetaAttr (that
  // would recurse forever — every node would build a child to hold its value,
  // which would build a child, ...). Read via ownAttr(RESERVED_KEY_VALUE) /
  // MetaAttr.value; set via setAttr(RESERVED_KEY_VALUE, ...).
  private _ownValue?: AttrValue;
  private _ownValueSet = false;
  private _children: MetaData[] = [];
  private _parent?: MetaData;
  private _frozen: boolean = false;

  // Registry-supplied coarse value type — set by the registry factory at node
  // construction (for field/attr nodes). Read via MetaField/MetaAttr.dataType.
  protected _dataType?: DataType;

  // ADR-0009 provenance. Always populated; defaults to `{ format: "code" }`
  // for programmatic construction (tests, factories, in-code builders). The
  // JSON parser overwrites via setSource() during tree walk; future phases
  // (overlay merge, super resolution) may overwrite with merged/resolved
  // variants. Excluded from canonical JSON serialization — loader-derived
  // state, not metadata.
  private _source: ErrorSource = { format: "code" };

  // Per-instance read cache: only populated once the node is frozen.
  private readonly _cache = new Map<string, unknown>();

  constructor(typeId: TypeId, name: string) {
    this.typeId = typeId;
    this.name = name;
  }

  // ---------------------------------------------------------------------------
  // Cache helper
  // ---------------------------------------------------------------------------

  /**
   * Memoize a derived read. Only caches once the node is frozen — a value
   * computed during the (mutable) load phase is never stored, so it cannot
   * go stale. After freeze the tree is immutable, so a cached entry is valid
   * for the node's lifetime; there is no invalidation.
   */
  protected cached<T>(key: string, compute: () => T): T {
    if (this._frozen && this._cache.has(key)) {
      return this._cache.get(key) as T;
    }
    const value = compute();
    if (this._frozen) this._cache.set(key, value);
    return value;
  }

  // ---------------------------------------------------------------------------
  // Convenience accessors
  // ---------------------------------------------------------------------------

  get type(): string {
    return this.typeId.type;
  }

  get subType(): string {
    return this.typeId.subType;
  }

  /** "package::name" if package is set, else just "name". Uses :: as separator (not .). */
  fqn(): string {
    if (this.package !== undefined) {
      return `${this.package}${PACKAGE_SEPARATOR}${this.name}`;
    }
    return this.name;
  }

  // ---------------------------------------------------------------------------
  // Freeze guard
  // ---------------------------------------------------------------------------

  private _assertNotFrozen(): void {
    if (this._frozen) {
      throw new Error(`Cannot mutate frozen MetaData ${this.fqn()}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Package
  // ---------------------------------------------------------------------------

  setPackage(pkg: string): void {
    this._assertNotFrozen();
    this.package = pkg;
  }

  /**
   * Loader-internal: record the file-default package captured at parse time.
   * See the `fileDefaultPackage` field doc. Honors the frozen-guard.
   * @internal
   */
  setFileDefaultPackage(pkg: string): void {
    this._assertNotFrozen();
    this.fileDefaultPackage = pkg;
  }

  /**
   * The node's EFFECTIVE qualified key for super-resolution matching:
   * `<pkg>::<name>` where pkg is the node's own package if set, else the
   * file-default package captured at parse time. Returns the bare name when
   * neither is available. Used by super-resolution ONLY — distinct from fqn(),
   * which stays bare for objects per the FR5d cross-port contract.
   */
  resolutionKey(): string {
    const pkg = this.package ?? this.fileDefaultPackage;
    if (pkg !== undefined && pkg !== "") {
      return `${pkg}${PACKAGE_SEPARATOR}${this.name}`;
    }
    return this.name;
  }

  // ---------------------------------------------------------------------------
  // Super
  // ---------------------------------------------------------------------------

  /** Returns the resolved super model, or undefined if not yet resolved. */
  get superData(): MetaData | undefined {
    return this._superData;
  }

  /** Temporary compatibility alias for `superData` — kept while super-resolve.ts still references this name; to be removed in a later task. */
  get superResolved(): MetaData | undefined {
    return this._superData;
  }

  /**
   * Sets the resolved super model. Normally called by Task 6's super resolution
   * after parsing and before freezing.
   */
  setSuperResolved(model: MetaData): void {
    this._assertNotFrozen();
    this._superData = model;
  }

  setSuper(ref: string): void {
    this._assertNotFrozen();
    this.superRef = ref;
  }

  // ---------------------------------------------------------------------------
  // isArray
  // ---------------------------------------------------------------------------

  setIsArray(val: boolean): void {
    this._assertNotFrozen();
    this.isArray = val;
  }

  // ---------------------------------------------------------------------------
  // dataType
  // ---------------------------------------------------------------------------

  /** Set the registry-supplied DataType. Called by the registry factory at
   *  node construction. */
  setDataType(dt: DataType): void {
    this._assertNotFrozen();
    this._dataType = dt;
  }

  // ---------------------------------------------------------------------------
  // source (ADR-0009 provenance)
  // ---------------------------------------------------------------------------

  /** Provenance envelope for this node. Always populated. See ADR-0009. */
  get source(): ErrorSource {
    return this._source;
  }

  /**
   * Loader-internal: assign provenance. Called by parser and merge phases as
   * they build the tree. Honors the frozen-guard like other setters.
   * @internal
   */
  setSource(s: ErrorSource): void {
    this._assertNotFrozen();
    this._source = s;
  }

  // ---------------------------------------------------------------------------
  // isAbstract
  // ---------------------------------------------------------------------------

  setIsAbstract(val: boolean): void {
    this._assertNotFrozen();
    this.isAbstract = val;
  }

  // ---------------------------------------------------------------------------
  // isMerge
  // ---------------------------------------------------------------------------

  setIsMerge(val: boolean): void {
    this._assertNotFrozen();
    this.isMerge = val;
  }

  // ---------------------------------------------------------------------------
  // Attributes
  // ---------------------------------------------------------------------------

  setAttr(name: string, value: AttrValue): void {
    this._assertNotFrozen();
    // The reserved "value" key is a node's own terminal value (e.g. a MetaAttr's
    // value). It is stored directly, never materialized as a nested MetaAttr —
    // doing so would recurse forever (each node would build a child to hold its
    // value). See _ownValue.
    if (name === RESERVED_KEY_VALUE) {
      this._ownValue = value;
      this._ownValueSet = true;
      return;
    }
    const existing = this._attrNodes.get(name);
    if (existing !== undefined) {
      existing.setAttr(RESERVED_KEY_VALUE, value);
      return;
    }
    // Resolve the attr's class. A declared subtype isn't known here (this is the
    // node, not the registry), so infer from the value shape — same rule the
    // serializer uses. The parser, which DOES know the declared subtype, builds
    // the instance directly via setMetaAttr (below).
    const subType = inferAttrSubType(value);
    const AttrClass = attrClassFor(subType);
    const node = new AttrClass(new TypeId(TYPE_ATTR, subType), name);
    node.setAttr(RESERVED_KEY_VALUE, value);
    this._attrNodes.set(name, node);
  }

  /** Attach a pre-built MetaAttr instance (the parser path, which knows the
   *  declared subtype). Replaces any existing attr of the same name. */
  setMetaAttr(node: MetaAttr): void {
    this._assertNotFrozen();
    this._attrNodes.set(node.name, node);
  }

  /** Own (locally declared) attr value for `name`, or undefined — excludes inherited. */
  ownAttr(name: string): AttrValue | undefined {
    if (name === RESERVED_KEY_VALUE) {
      return this._ownValueSet ? this._ownValue : undefined;
    }
    return this._attrNodes.get(name)?.value;
  }

  /** Own (locally declared) MetaAttr instance for `name`, or undefined. */
  ownMetaAttr(name: string): MetaAttr | undefined {
    return this._attrNodes.get(name);
  }

  /** Own MetaAttr instances, insertion-ordered, frozen; excludes inherited. */
  ownMetaAttrs(): readonly MetaAttr[] {
    return this.cached("ownMetaAttrs", () => Object.freeze([...this._attrNodes.values()]));
  }

  /** Own (locally declared) attr value map; excludes inherited. Cached. */
  ownAttrs(): ReadonlyMap<string, AttrValue> {
    return this.cached("ownAttrs", () => {
      const m = new Map<string, AttrValue>();
      for (const [name, node] of this._attrNodes) {
        if (node.value !== undefined) m.set(name, node.value);
      }
      return m;
    });
  }

  /** True if `name` is an own (locally declared) attr — excludes inherited. */
  ownHasAttr(name: string): boolean {
    if (name === RESERVED_KEY_VALUE) {
      return this._ownValueSet;
    }
    return this._attrNodes.has(name);
  }

  // ---------------------------------------------------------------------------
  // Effective attr accessors — the default. Own + attrs inherited via the
  // super chain (own winning on a key conflict). Own-only access is the
  // explicit own* opt-in above.
  // ---------------------------------------------------------------------------

  /**
   * Effective attrs — own + inherited via the super chain, own winning on a key conflict; cached.
   * Do not cast to `Map` and mutate — the same reference is returned on every call
   * after freeze, so a mutation would corrupt subsequent reads.
   */
  attrs(): ReadonlyMap<string, AttrValue> {
    return this.cached("attrs", () => this._effectiveAttrs(new Set([this])));
  }

  /** Effective attr value for `name`, or undefined. */
  attr(name: string): AttrValue | undefined {
    return this.attrs().get(name);
  }

  /** True if `name` resolves to an effective attr (own or inherited). */
  hasAttr(name: string): boolean {
    return this.attrs().has(name);
  }

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------

  addChild(child: MetaData): void {
    this._assertNotFrozen();
    child._parent = this;
    this._children.push(child);
  }

  /** The node this node was added to as a child, or undefined for the tree root. */
  get parent(): MetaData | undefined {
    return this._parent;
  }

  /** Walk up to the top of the tree this node belongs to. */
  root(): MetaData {
    let node: MetaData = this;
    while (node._parent !== undefined) {
      node = node._parent;
    }
    return node;
  }

  /** Own (locally declared) children — a cached frozen array; excludes children inherited via extends. */
  ownChildren(): readonly MetaData[] {
    return this.cached("ownChildren", () => Object.freeze([...this._children]));
  }

  /** Own children whose type matches — excludes inherited. */
  ownChildrenOfType(type: string): MetaData[] {
    return this.ownChildren().filter((c) => c.type === type);
  }

  /** Own children matching both type and subType — excludes inherited. */
  ownChildrenOfSubType(type: string, subType: string): MetaData[] {
    return this.ownChildren().filter((c) => c.type === type && c.subType === subType);
  }

  /** First own child with matching name, or undefined — excludes inherited. */
  ownChildByName(name: string): MetaData | undefined {
    return this.ownChildren().find((c) => c.name === name);
  }

  /** First own child matching both type and name, or undefined — excludes inherited. */
  ownChildByTypeAndName(type: string, name: string): MetaData | undefined {
    return this.ownChildren().find((c) => c.type === type && c.name === name);
  }

  // ---------------------------------------------------------------------------
  // Effective child accessors — the default. Own + children inherited via the
  // super chain (own shadowing super on a (type, name) match). Own-only access
  // is the explicit own* opt-in above.
  // ---------------------------------------------------------------------------

  /** Effective children: own + inherited via the super chain, own shadowing super. Cached, frozen. */
  children(): readonly MetaData[] {
    return this.cached("children", () => Object.freeze(this._effectiveChildren(new Set([this]))));
  }

  /** Effective children whose type matches. */
  childrenOfType(type: string): MetaData[] {
    return this.children().filter((c) => c.type === type);
  }

  /** Effective children matching both type and subType. */
  childrenOfSubType(type: string, subType: string): MetaData[] {
    return this.children().filter((c) => c.type === type && c.subType === subType);
  }

  /** First effective child with matching name, or undefined. */
  childByName(name: string): MetaData | undefined {
    return this.children().find((c) => c.name === name);
  }

  /** First effective child matching both type and name, or undefined. */
  childByTypeAndName(type: string, name: string): MetaData | undefined {
    return this.children().find((c) => c.type === type && c.name === name);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers for effective attr / child computation
  // ---------------------------------------------------------------------------

  private _effectiveAttrs(visited: Set<MetaData>): Map<string, AttrValue> {
    const ownValues = (): Map<string, AttrValue> => {
      const m = new Map<string, AttrValue>();
      for (const [name, node] of this._attrNodes) {
        if (node.value !== undefined) m.set(name, node.value);
      }
      return m;
    };
    if (this._superData === undefined || visited.has(this._superData)) {
      return ownValues();
    }
    visited.add(this._superData);
    const result = this._superData._effectiveAttrs(visited);
    for (const [k, v] of ownValues()) {
      result.set(k, v);
    }
    return result;
  }

  private _effectiveChildren(visited: Set<MetaData>): MetaData[] {
    if (this._superData === undefined || visited.has(this._superData)) {
      return [...this._children];
    }
    visited.add(this._superData);

    // Start from the super's effective children (already a copy from the recursive call).
    const result = this._superData._effectiveChildren(visited);

    // Track which of our own children matched (overrode) a super child position.
    const appendQueue: MetaData[] = [];

    for (const ownChild of this._children) {
      // Find the index in result that has the same (type, name).
      const idx = result.findIndex(
        (sc) => sc.type === ownChild.type && sc.name === ownChild.name,
      );
      if (idx !== -1) {
        // Replace the super child with our own (in-place override).
        result[idx] = ownChild;
      } else {
        // No matching super child — will be appended at the end.
        appendQueue.push(ownChild);
      }
    }

    // Append non-overriding own children.
    result.push(...appendQueue);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  freeze(): void {
    if (this._frozen) {
      return; // Idempotent
    }
    this._frozen = true;
    for (const child of this._children) {
      child.freeze();
    }
  }

  isFrozen(): boolean {
    return this._frozen;
  }
}
