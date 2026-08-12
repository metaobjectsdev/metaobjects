export const SERVER_LANGS = ["typescript", "java", "kotlin", "csharp", "python"] as const;
export type ServerLang = (typeof SERVER_LANGS)[number];

export const CLIENT_FRAMEWORKS = ["react", "tanstack", "angular"] as const;
export type ClientFramework = (typeof CLIENT_FRAMEWORKS)[number];

/**
 * Opt-in capability concerns, detected from OBSERVED project state (never a config
 * flag — a flag goes stale, observed metadata cannot). Each token gates a
 * `references/<token>.md` fragment the same way a language/framework token does.
 * Add a new concern here; nothing else in the assembler needs to change.
 */
export const CONCERN_TOKENS = ["requirements"] as const;
export type ConcernToken = (typeof CONCERN_TOKENS)[number];

/** Always-present token: schema migrations are TS-owned for every port (ADR-0015). */
export const MIGRATION_TOKEN = "migration";

export const SKILL_NAMES = [
  "metaobjects-authoring",
  "metaobjects-codegen",
  "metaobjects-runtime-ui",
  "metaobjects-prompts",
  "metaobjects-verify",
  "metaobjects-audit",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** The resolved tech-stack of a consumer project. */
export interface Stack {
  servers: ServerLang[]; // deduped, in SERVER_LANGS order
  clients: ClientFramework[]; // deduped, in CLIENT_FRAMEWORKS order
  concerns: ConcernToken[]; // deduped, in CONCERN_TOKENS order — observed capability usage
  /** servers ∪ clients ∪ concerns ∪ {"migration"} — the install-selection set for reference fragments. */
  tokens: ReadonlySet<string>;
}

/** A file the assembler emits, path relative to the consumer project root. */
export interface AssembledFile {
  path: string; // e.g. ".metaobjects/AGENTS.md", ".claude/skills/metaobjects-codegen/references/java.md"
  contents: string;
}
