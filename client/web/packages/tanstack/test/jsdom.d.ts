// Minimal ambient declaration for jsdom — allows importing JSDOM without @types/jsdom.
// The test/setup.ts file uses JSDOM only to populate global.document/window for
// component tests; we don't need full type coverage here.
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: Record<string, unknown>);
    readonly window: {
      document: Document;
    } & typeof globalThis;
  }
}
