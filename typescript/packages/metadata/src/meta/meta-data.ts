import { TypeId } from "../registry.js";
import { PACKAGE_SEPARATOR } from "../constants.js";
import type { DataType } from "../data-type.js";

export type AttrValue = string | number | boolean | string[];

export abstract class MetaData {
  readonly typeId: TypeId;
  readonly name: string;

  // Identity / packaging
  package?: string;
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

  // Internal storage
  private _attrs = new Map<string, AttrValue>();
  private _children: MetaData[] = [];
  private _parent?: MetaData;
  private _frozen: boolean = false;

  // Registry-supplied coarse value type — set by the registry factory at node
  // construction (for field/attr nodes). Read via MetaField/MetaAttr.dataType.
  protected _dataType?: DataType;

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
    this._attrs.set(name, value);
  }

  /** Own (locally declared) attr value for `name`, or undefined — excludes inherited. */
  ownAttr(name: string): AttrValue | undefined {
    return this._attrs.get(name);
  }

  /** Own (locally declared) attrs — a cached map; excludes attrs inherited via extends. */
  ownAttrs(): ReadonlyMap<string, AttrValue> {
    return this.cached("ownAttrs", () => new Map(this._attrs));
  }

  /** True if `name` is an own (locally declared) attr — excludes inherited. */
  ownHasAttr(name: string): boolean {
    return this._attrs.has(name);
  }

  // ---------------------------------------------------------------------------
  // Effective attr accessors — the default. Own + attrs inherited via the
  // super chain (own winning on a key conflict). Own-only access is the
  // explicit own* opt-in above.
  // ---------------------------------------------------------------------------

  /** Effective attrs: own + inherited via the super chain, own winning on a key conflict. Cached. */
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
    return this._children.filter((c) => c.type === type);
  }

  /** Own children matching both type and subType — excludes inherited. */
  ownChildrenOfSubType(type: string, subType: string): MetaData[] {
    return this._children.filter((c) => c.type === type && c.subType === subType);
  }

  /** First own child with matching name, or undefined — excludes inherited. */
  ownChildByName(name: string): MetaData | undefined {
    return this._children.find((c) => c.name === name);
  }

  /** First own child matching both type and name, or undefined — excludes inherited. */
  ownChildByTypeAndName(type: string, name: string): MetaData | undefined {
    return this._children.find((c) => c.type === type && c.name === name);
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
    if (this._superData === undefined || visited.has(this._superData)) {
      return new Map(this._attrs);
    }
    visited.add(this._superData);
    // Start with the super chain's effective attrs, then override with own.
    const result = this._superData._effectiveAttrs(visited);
    for (const [k, v] of this._attrs) {
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
