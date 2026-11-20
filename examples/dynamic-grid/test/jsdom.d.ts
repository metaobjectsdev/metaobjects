// Minimal ambient declaration for jsdom, so the DOM setup can import JSDOM without @types/jsdom.
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: Record<string, unknown>);
    readonly window: { document: Document } & typeof globalThis;
  }
}
