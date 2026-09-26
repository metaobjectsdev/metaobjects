// `@metaobjectsdev/render/providers` — the NODE-ONLY provider entry.
//
// The root entry (`@metaobjectsdev/render`) is browser-safe and must stay that
// way; anything that touches the filesystem lives behind this subpath.
export { FilesystemProvider, DEFAULT_TEMPLATE_EXTENSION } from "./filesystem-provider.js";
export { type Provider, InMemoryProvider } from "./provider.js";
