import { TypeId } from "../registry.js";
import { PACKAGE_SEPARATOR } from "../constants.js";

export type AttrValue = string | number | boolean | string[];

export abstract class MetaData {
  readonly typeId: TypeId;
  readonly name: string;

  // Identity / packaging
  package?: string;
  superRef?: string;         // raw super reference string, pre-resolution
  private _superData?: MetaData; // post-resolution pointer (set by Task 6)
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
  private _frozen: boolean = false;

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

  /** Temporary compatibility alias for `superData` — kept while super-resolve.ts and views.ts still reference this name; to be removed in a later task. */
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

  attr(name: string): AttrValue | undefined {
    return this._attrs.get(name);
  }

  /** Returns a defensive copy — mutating the result does not affect this model. */
  attrs(): Map<string, AttrValue> {
    return new Map(this._attrs);
  }

  hasAttr(name: string): boolean {
    return this._attrs.has(name);
  }

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------

  addChild(child: MetaData): void {
    this._assertNotFrozen();
    this._children.push(child);
  }

  /** Returns a defensive copy of the children array — mutating the result does not affect this model. */
  children(): readonly MetaData[] {
    return [...this._children];
  }

  /** Returns a new array of children whose type matches. */
  childrenOfType(type: string): MetaData[] {
    return this._children.filter((c) => c.type === type);
  }

  /** Returns a new array of children matching both type and subType. */
  childrenOfSubType(type: string, subType: string): MetaData[] {
    return this._children.filter((c) => c.type === type && c.subType === subType);
  }

  /** Returns the first child with matching name, or undefined. */
  childByName(name: string): MetaData | undefined {
    return this._children.find((c) => c.name === name);
  }

  /** Returns the first child matching both type and name, or undefined. */
  childByTypeAndName(type: string, name: string): MetaData | undefined {
    return this._children.find((c) => c.type === type && c.name === name);
  }

  /**
   * Returns the first child matching (type, name), walking the super chain if not found locally.
   * Java parity: matches MetaObject.getMetaField(name)'s behavior of falling back to getSuperObject().getMetaField(name).
   * Cycle-safe: if the super chain contains a cycle, lookup stops at the cycle.
   */
  effectiveChildByTypeAndName(type: string, name: string): MetaData | undefined {
    return this._effectiveChildByTypeAndName(type, name, new Set([this]));
  }

  private _effectiveChildByTypeAndName(
    type: string,
    name: string,
    visited: Set<MetaData>,
  ): MetaData | undefined {
    const own = this._children.find((c) => c.type === type && c.name === name);
    if (own !== undefined) return own;
    if (this._superData === undefined || visited.has(this._superData)) {
      return undefined;
    }
    visited.add(this._superData);
    return this._superData._effectiveChildByTypeAndName(type, name, visited);
  }

  // ---------------------------------------------------------------------------
  // Effective view (own + inherited via super chain)
  // ---------------------------------------------------------------------------

  /**
   * Returns a Map of effective attrs: super's attrs merged with own, where own wins.
   * Returns a defensive copy — safe to mutate without affecting this model.
   * Cycle-safe: if the super chain contains a cycle, resolution stops at the cycle.
   */
  effectiveAttrs(): Map<string, AttrValue> {
    const merged = this.cached("effectiveAttrs", () => this._effectiveAttrs(new Set([this])));
    return new Map(merged);
  }

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

  /**
   * Returns the effective children list: super's children merged with own.
   * Own children with the same (type, name) as a super child replace that super child
   * in-position. Own children that don't conflict are appended after super's.
   * Cycle-safe: if the super chain contains a cycle, resolution stops at the cycle.
   */
  effectiveChildren(): MetaData[] {
    return this.cached("effectiveChildren", () => this._effectiveChildren(new Set([this])));
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

/** Compatibility alias — consumers that treat a node as "any metadata node".
 *  Removed in rebuild Phase 4 when all consumers adopt the typed tree. */
export type MetaModel = MetaData;
