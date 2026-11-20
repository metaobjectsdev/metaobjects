// A DOM for the component tests, preloaded by bunfig.toml before any test file. It has to
// exist before react-dom is first evaluated: react-dom decides at load time whether it can
// listen for input events, and without a document it decides it cannot.
import { JSDOM } from "jsdom";

if (typeof globalThis.document === "undefined") {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
}
