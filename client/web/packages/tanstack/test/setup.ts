import { JSDOM } from "jsdom";

// Idempotent: if a global document has already been registered (e.g. by the
// client/web root bunfig.toml preload), reuse it. Replacing globalThis.document
// after `@testing-library/dom`'s `screen` module is evaluated leaves `screen`
// bound to the previous, now-orphaned document.body — which makes every
// `screen.*` query look at an empty body.
if (typeof globalThis.document === "undefined") {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  global.document = dom.window.document as any;
  global.window = dom.window as any;
}
