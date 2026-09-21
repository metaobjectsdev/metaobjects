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
