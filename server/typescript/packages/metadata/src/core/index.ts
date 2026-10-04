// @metaobjectsdev/metadata/core — server-side capabilities.
//
// This entry point holds everything that touches node:fs or the `yaml`
// dependency: the file loaders, the YAML authoring parser, and the
// load-and-export convenience. The root `@metaobjectsdev/metadata` entry is
// browser-safe and imports none of this. See the package README.

// Source impls — the node:fs-backed MetaDataSource implementations. Live
// under `loader/sources/`; re-exported here so server-side consumers can pull
// them from the same `/core` entry that already houses the YAML parser.
export { FileSource } from "../loader/sources/file-source.js";
export { DirectorySource } from "../loader/sources/directory-source.js";
export type { DirectoryOptions } from "../loader/sources/directory-source.js";
export { UriSource } from "../loader/sources/uri-source.js";

export { parseYaml } from "./parser-yaml.js";
export { loadAndExportJson } from "./export-json.js";
export type { ExportResult } from "./export-json.js";

// The `meta verify` field lint's structural pre-parse walk. Lives here, not on the
// root entry, because it parses YAML.
export { declaredDuplicateFields } from "../loader/declared-duplicate-fields.js";
export type { DeclaredDuplicateField } from "../loader/declared-duplicate-fields.js";
