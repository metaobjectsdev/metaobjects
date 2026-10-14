// ADR-0034 Amendment 9 — one way to generate. Documentation is written by generators the
// project lists in `generators`, and `meta gen` runs them. The docs command, `meta verify
// --docs` and the `docs` config block are gone, and each says so in the amendment's fixed
// words, pointing at the migration section an agent can apply by hand.

/** The migration guide every message below points at, and the section for this port. */
export const DOCS_MIGRATION_GUIDE = "https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md";
const SECTION = `section "TypeScript"`;
/** Where a TypeScript project declares a docs generator. */
const WHERE = "in `generators` in metaobjects.config.ts";

/** What `meta docs` prints before it exits 2. */
export const REMOVED_DOCS_COMMAND =
  "`meta docs` was removed in 1.1.0. `meta gen` writes documentation now: declare each docs " +
  `generator ${WHERE}. See ${DOCS_MIGRATION_GUIDE}, ${SECTION}.`;

/** What `meta verify --docs` prints before it exits 2. */
export const REMOVED_VERIFY_DOCS =
  "`meta verify --docs` was removed in 1.1.0. `meta verify --codegen` checks documentation now, " +
  `with everything else \`generators\` declares. See ${DOCS_MIGRATION_GUIDE}, ${SECTION}.`;

/** What a gen run prints, and fails on, when there is no config to read the list from. */
export const NO_CONFIG_MESSAGE =
  "meta gen: no metaobjects.config.ts. Nothing is generated until a config declares it, " +
  "documentation included; `meta init` writes one. A 1.0 project that ran `meta docs` with no " +
  `config: see ${DOCS_MIGRATION_GUIDE}, ${SECTION}.`;

/** True when a loaded config still carries the 1.0 `docs` block. */
export function hasLegacyDocsBlock(config: object): boolean {
  return Object.hasOwn(config, "docs");
}

/** What `command` prints, and fails on, before it writes anything, for a 1.0 `docs` block. */
export function legacyDocsConfigMessage(command: string): string {
  return (
    `${command}: found 1.0 docs configuration (the docs block in metaobjects.config.ts). ` +
    "Nothing reads it any more, so this run would write no documentation. Declare each docs " +
    `generator ${WHERE}. See ${DOCS_MIGRATION_GUIDE}, ${SECTION}.`
  );
}
