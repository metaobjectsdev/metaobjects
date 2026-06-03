export const SERVER_LANGS = ["typescript", "java", "kotlin", "csharp", "python"] as const;
export type ServerLang = (typeof SERVER_LANGS)[number];

export const CLIENT_FRAMEWORKS = ["react", "tanstack", "angular"] as const;
export type ClientFramework = (typeof CLIENT_FRAMEWORKS)[number];

/** Always-present token: schema migrations are TS-owned for every port (ADR-0015). */
export const MIGRATION_TOKEN = "migration";

export const SKILL_NAMES = [
  "metaobjects-authoring",
  "metaobjects-codegen",
  "metaobjects-runtime-ui",
  "metaobjects-prompts",
  "metaobjects-verify",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** The resolved tech-stack of a consumer project. */
export interface Stack {
  servers: ServerLang[]; // deduped, in SERVER_LANGS order
  clients: ClientFramework[]; // deduped, in CLIENT_FRAMEWORKS order
  /** servers ∪ clients ∪ {"migration"} — the install-selection set for reference fragments. */
  tokens: ReadonlySet<string>;
}

/** A file the assembler emits, path relative to the consumer project root. */
export interface AssembledFile {
  path: string; // e.g. ".metaobjects/AGENTS.md", ".claude/skills/metaobjects-codegen/references/java.md"
  contents: string;
}
