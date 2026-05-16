// Typed-view generator interfaces — the POC parallel to codegen-ts/src/generator.ts.
// Uses concrete typed-view types (MetaObject / MetaRoot) throughout, not the raw MetaData base.

import type { MetaObject, MetaRoot } from "@metaobjects/metadata";
import type { RenderContext } from "./render-context.js";
import type { ResolvedGenConfig } from "@metaobjects/codegen-ts";

export interface EmittedFile {
  path: string;
  content: string;
  generatedBy?: string;
}

export interface GenContext {
  entities: MetaObject[];
  loadedRoot: MetaRoot;
  matches: (entity: MetaObject) => boolean;
  config: ResolvedGenConfig;
  renderContext?: RenderContext;
  warn: (msg: string) => void;
}

export interface Generator {
  name: string;
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
}
