// The narrow, read-only metadata surface a runtime UI consumer needs.
//
// Declared here rather than imported from @metaobjectsdev/metadata because this
// package must satisfy it with a browser-built model too: the metadata package's
// root barrel exports MetaDataLoader, which transitively imports `node:url`, so
// it cannot be bundled for a browser (#287). A real MetaObject satisfies these
// interfaces structurally, so server-side callers are unaffected.
//
// ADR-0039: every accessor here is the RESOLVING one. `attr()` must answer with
// inherited values, and `views()`/`fields()` must include inherited members.

/** A metadata attribute reader. Returns `undefined` for an unset OR unregistered name. */
export type AttrReader = (name: string) => unknown;

export interface MetaViewRead {
  readonly subType: string;
  attr: AttrReader;
}

export interface MetaFieldRead {
  readonly name: string;
  readonly subType: string;
  attr: AttrReader;
  views(): MetaViewRead[];
}

export interface MetaLayoutRead {
  readonly name: string;
  readonly subType: string;
  attr: AttrReader;
}

/** One object (entity / value / projection) as a runtime UI reads it. */
export interface MetaRead {
  readonly name: string;
  /**
   * The node's OWN package, when declared. Undefined for a node that inherits its
   * package from the declaring file's default rather than declaring one itself —
   * the same "own, not resolved" reading `MetaData.package` carries server-side
   * (objects never auto-inherit a file's default package; see parser-core.ts).
   *
   * `object(name)` and the model's `byName` lookup key on the SHORT name only, so
   * two same-named objects in different packages (a shape this repo models
   * deliberately — see `fixtures/conformance/xpkg-collision-*`) are NOT
   * disambiguated by `object()`. A caller that might see a cross-package
   * collision should walk `objects()` and filter on `package` itself.
   */
  readonly package?: string;
  readonly subType: string;
  attr: AttrReader;
  fields(): MetaFieldRead[];
  layouts(): MetaLayoutRead[];
}

/** The whole model, as returned by `loadMetaModel`. */
export interface MetaModelRead {
  objects(): MetaRead[];
  object(name: string): MetaRead | undefined;
}
