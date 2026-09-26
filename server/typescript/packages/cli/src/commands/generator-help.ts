// The dependency-free half of `meta generator` — its flags and help text — so the CLI entry
// point can print `meta generator --help` without loading the codegen packages the command
// itself needs.

/** Where owned generators live — the directory `meta init` scaffolds and `meta eject` fills. */
export const OWNED_GENERATORS_DIR = "codegen/generators";
export const CONFIG_FILE = "metaobjects.config.ts";

export const GENERATOR_SCOPES = ["entity", "package", "model"] as const;
export type GeneratorScope = (typeof GENERATOR_SCOPES)[number];

export const GENERATOR_OPTIONS = {
  "scope": { type: "string", default: "entity" },
  "force": { type: "boolean", default: false },
  "no-wire": { type: "boolean", default: false },
} as const;

export const GENERATOR_HELP = `meta generator — write a generator of your own

USAGE:
  meta generator new <name> [--scope entity|package|model] [--force] [--no-wire]

Writes ${OWNED_GENERATORS_DIR}/<name>.ts — a small, commented, WORKING generator — and
adds its import and entry to ${CONFIG_FILE}, so \`meta gen\` runs it and
\`meta verify --codegen\` gates its output straight away. Then edit the emit to produce
what you need: OpenAPI, JSON Schema, a client, DTOs, docs — anything the model describes.

This is the primary way to get an output MetaObjects does not ship. Reach for
\`meta eject <name>\` instead only when a reference generator already emits something
close to what you want (\`meta gen --list\` is the catalog).

<name> is kebab-case (json-schema, openapi, service-layer). It names the file, the
generator's \`name\` in diagnostics, and the exported factory (jsonSchemaGenerator).

FLAGS:
  --scope <scope>   What the generator walks, one file per unit (default: entity):
                      entity   one file per object in the model
                      package  one file per metadata package
                      model    one file for the whole model
  --force           Overwrite an existing ${OWNED_GENERATORS_DIR}/<name>.ts
  --no-wire         Write the file only; print the import and entry to add yourself
  --help, -h        Print this help

Every port's shape, and JSON Schema + OpenAPI 3.1 examples to copy: the guide
docs/recipes/write-your-own-generator.md in the MetaObjects repository
(github.com/metaobjectsdev), and the metaobjects-codegen skill \`meta init\` installs.
`;
