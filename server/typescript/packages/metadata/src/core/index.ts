// @metaobjectsdev/metadata/core — server-side capabilities.
//
// This entry point holds everything that touches node:fs or the `yaml`
// dependency: the file loaders, the YAML authoring parser, and the
// load-and-export convenience. The root `@metaobjectsdev/metadata` entry is
// browser-safe and imports none of this. See the package README.

export { FileSource } from "./file-source.js";
export { FileMetaDataLoader } from "./file-meta-data-loader.js";
export { parseYaml } from "./parser-yaml.js";
export { loadAndExportJson } from "./export-json.js";
export type { ExportResult } from "./export-json.js";
