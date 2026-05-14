import { TypeId } from "./registry.js";
import { PACKAGE_SEPARATOR } from "./constants.js";

export type AttrValue = string | number | boolean | string[];

export class MetaModel {
  readonly typeId: TypeId;
  readonly name: string;

  // Identity / packaging
  package?: string;
  superRef?: string;         // raw super reference string, pre-resolution
  private _superResolved?: MetaModel; // post-resolution pointer (set by Task 6)
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
  private _children: MetaModel[] = [];
  private _frozen: boolean = false;

  constructor(typeId: TypeId, name: string) {
    this.typeId = typeId;
    this.name = name;
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
      throw new Error(`Cannot mutate frozen MetaModel ${this.fqn()}`);
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
  get superResolved(): MetaModel | undefined {
    return this._superResolved;
  }

  /**
   * Sets the resolved super model. Normally called by Task 6's super resolution
   * after parsing and before freezing.
   */
  setSuperResolved(model: MetaModel): void {
    this._assertNotFrozen();
    this._superResolved = model;
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

  addChild(child: MetaModel): void {
    this._assertNotFrozen();
    this._children.push(child);
  }

  /** Returns a defensive copy of the children array — mutating the result does not affect this model. */
  children(): readonly MetaModel[] {
    return [...this._children];
  }

  /** Returns a new array of children whose type matches. */
  childrenOfType(type: string): MetaModel[] {
    return this._children.filter((c) => c.type === type);
  }

  /** Returns a new array of children matching both type and subType. */
  childrenOfSubType(type: string, subType: string): MetaModel[] {
    return this._children.filter((c) => c.type === type && c.subType === subType);
  }

  /** Returns the first child with matching name, or undefined. */
  childByName(name: string): MetaModel | undefined {
    return this._children.find((c) => c.name === name);
  }

  /** Returns the first child matching both type and name, or undefined. */
  childByTypeAndName(type: string, name: string): MetaModel | undefined {
    return this._children.find((c) => c.type === type && c.name === name);
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
    return this._effectiveAttrs(new Set([this]));
  }

  private _effectiveAttrs(visited: Set<MetaModel>): Map<string, AttrValue> {
    if (this._superResolved === undefined || visited.has(this._superResolved)) {
      return new Map(this._attrs);
    }
    visited.add(this._superResolved);
    // Start with the super chain's effective attrs, then override with own.
    const result = this._superResolved._effectiveAttrs(visited);
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
  effectiveChildren(): MetaModel[] {
    return this._effectiveChildren(new Set([this]));
  }

  private _effectiveChildren(visited: Set<MetaModel>): MetaModel[] {
    if (this._superResolved === undefined || visited.has(this._superResolved)) {
      return [...this._children];
    }
    visited.add(this._superResolved);

    // Start from the super's effective children (already a copy from the recursive call).
    const result = this._superResolved._effectiveChildren(visited);

    // Track which of our own children matched (overrode) a super child position.
    const appendQueue: MetaModel[] = [];

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
