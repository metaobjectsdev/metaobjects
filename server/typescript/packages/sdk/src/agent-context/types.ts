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
  "metaobjects-audit",
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

/**
 * Where the skills install unless the project chose otherwise: the directory Claude Code reads.
 * Any other assistant takes `--skills-dir` (`.agents/skills` is the shared location several
 * read), and the always-on text names the chosen directory so an assistant that does not load
 * skills can still open them by path.
 */
export const DEFAULT_SKILLS_DIR = ".claude/skills";

/**
 * A skills directory as a clean project-relative POSIX path, or a thrown error naming what is
 * wrong. Refuses an absolute path and any `..` segment: the scaffolder writes and prunes files
 * under it, so it must stay inside the project.
 */
export function normalizeSkillsDir(raw: string): string {
  const posix = raw.trim().replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix)) {
    throw new Error(`--skills-dir must be relative to the project root, got '${raw}'`);
  }
  const segments = posix.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) throw new Error("--skills-dir must name a directory inside the project");
  if (segments.includes("..")) {
    throw new Error(`--skills-dir must stay inside the project (no '..'), got '${raw}'`);
  }
  return segments.join("/");
}
