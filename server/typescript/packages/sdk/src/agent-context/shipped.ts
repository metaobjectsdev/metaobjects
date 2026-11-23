// The static agent files, assembled once at build time for every stack a non-TypeScript port's
// own command serves, so that command copies them instead of re-implementing the assembler
// (1.3.0 design call 17). One tree per server language and client choice; the files are stored
// once each, by content, because most of a tree is the same skill text in every stack.
//
// The trees are pinned to `main` and the default skills directory, as the content is authored.
// A port's command makes the two substitutions its own release needs from the manifest's
// fields, with nothing else to know: it replaces `docsLinkPrefix + docsRef + "/"` with
// `docsLinkPrefix + <its release tag> + "/"` in every file (what `pinDocsRefs` does), and
// writes each file at its `path`.
import { createHash } from "node:crypto";
import { DOCS_DEFAULT_REF, DOCS_REPO_URL } from "@metaobjectsdev/metadata";
import { assemble } from "./assemble.js";
import { makeStack } from "./resolve.js";
import {
  CLIENT_FRAMEWORKS, DEFAULT_SKILLS_DIR, SERVER_LANGS,
  type ClientFramework, type ServerLang,
} from "./types.js";

/** The version of the manifest's shape. A port refuses a manifest whose schema it does not know. */
export const SHIPPED_AGENT_CONTEXT_SCHEMA = 1;

/** The manifest's file name, at the root of the shipped tree. */
export const SHIPPED_MANIFEST_FILE = "manifest.json";

/** The directory, under the shipped tree, that holds each distinct file once. */
export const SHIPPED_FILES_DIR = "files";

/**
 * The server-language sets a port's command serves. Each server language alone, and Java with
 * Kotlin together: the two share one Maven goal (`metaobjects:agent-docs`), so a project on both
 * gets one always-on file naming both loops. TypeScript is here too, though the Node CLI
 * assembles its own: a TypeScript tree is what the other trees are checked against.
 */
export const SHIPPED_SERVER_SETS: readonly (readonly ServerLang[])[] = [
  ...SERVER_LANGS.map((s) => [s] as const),
  ["java", "kotlin"],
];

/**
 * The client choices. TanStack is never shipped without React: its codegen and its runtime
 * both build on the React package, so a TanStack project is a React project.
 */
export const SHIPPED_CLIENT_SETS: readonly (readonly ClientFramework[])[] = [
  [],
  ["react"],
  ["react", "tanstack"],
  ["angular"],
];

/** A stack as a set of server languages and clients, in any order. */
export interface StackChoice {
  readonly servers: readonly ServerLang[];
  readonly clients: readonly ClientFramework[];
}

/** A stack's id: its server languages then its clients, each in their canonical order, joined by `-`. */
export function shippedStackId(stack: StackChoice): string {
  const servers = SERVER_LANGS.filter((s) => stack.servers.includes(s));
  const clients = CLIENT_FRAMEWORKS.filter((c) => stack.clients.includes(c));
  return [...servers, ...clients].join("-");
}

/** One file of one shipped tree. */
export interface ShippedFileRef {
  /** Where the file goes, relative to the project root. */
  readonly path: string;
  /** The stored file it copies: a name under {@link SHIPPED_FILES_DIR}. */
  readonly file: string;
}

/** One stack's tree. */
export interface ShippedStack {
  readonly id: string;
  readonly servers: readonly ServerLang[];
  readonly clients: readonly ClientFramework[];
  readonly files: readonly ShippedFileRef[];
}

/** The manifest a port reads. */
export interface ShippedManifest {
  readonly schema: number;
  /** The ref every guide link in the files is pinned to. */
  readonly docsRef: string;
  /** What precedes the ref in a guide link: `<repo url>/blob/`. */
  readonly docsLinkPrefix: string;
  /** The directory the skills' paths start with. */
  readonly skillsDir: string;
  readonly stacks: readonly ShippedStack[];
}

/** The whole shipped tree: the manifest, and each distinct file by its stored name. */
export interface ShippedAgentContext {
  readonly manifest: ShippedManifest;
  readonly files: ReadonlyMap<string, string>;
}

/**
 * A stored file's name: its content hash, so a file shared by many stacks is stored once and
 * a change to it renames it. Sixteen hex characters are plenty for a few hundred files.
 */
function storedName(contents: string): string {
  return `${createHash("sha256").update(contents, "utf8").digest("hex").slice(0, 16)}.md`;
}

/** Assemble every shipped stack from the content tree. Pure given the content tree. */
export function buildShippedAgentContext(contentRoot: string): ShippedAgentContext {
  const files = new Map<string, string>();
  const stacks: ShippedStack[] = [];
  for (const servers of SHIPPED_SERVER_SETS) {
    for (const clients of SHIPPED_CLIENT_SETS) {
      const stack = makeStack([...servers], [...clients]);
      const refs = assemble({ contentRoot, stack, docsRef: DOCS_DEFAULT_REF, skillsDir: DEFAULT_SKILLS_DIR })
        .map((f): ShippedFileRef => {
          const file = storedName(f.contents);
          const prior = files.get(file);
          if (prior !== undefined && prior !== f.contents) {
            throw new Error(`agent-context: two different files share the stored name ${file}`);
          }
          files.set(file, f.contents);
          return { path: f.path, file };
        });
      stacks.push({ id: shippedStackId(stack), servers: stack.servers, clients: stack.clients, files: refs });
    }
  }
  const manifest: ShippedManifest = {
    schema: SHIPPED_AGENT_CONTEXT_SCHEMA,
    docsRef: DOCS_DEFAULT_REF,
    docsLinkPrefix: `${DOCS_REPO_URL}/blob/`,
    skillsDir: DEFAULT_SKILLS_DIR,
    stacks,
  };
  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { manifest, files: sorted };
}

/** The manifest as it is written: two-space JSON with a trailing newline. */
export function serializeShippedManifest(manifest: ShippedManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Every file of the shipped tree, keyed by its path relative to the tree's root: the manifest
 * and each stored file. What the build writes and what the drift check compares.
 */
export function shippedTreeFiles(shipped: ShippedAgentContext): Map<string, string> {
  const out = new Map<string, string>([[SHIPPED_MANIFEST_FILE, serializeShippedManifest(shipped.manifest)]]);
  for (const [name, contents] of shipped.files) out.set(`${SHIPPED_FILES_DIR}/${name}`, contents);
  return out;
}

/**
 * The files a port writes for one project: the stack's tree with every guide link pinned to
 * `docsRef`. The reference for what a port's command does, and what the cross-port check runs.
 */
export function materializeShippedStack(
  shipped: Pick<ShippedAgentContext, "manifest" | "files">,
  stack: StackChoice,
  docsRef: string,
): { path: string; contents: string }[] {
  const id = shippedStackId(stack);
  const entry = shipped.manifest.stacks.find((s) => s.id === id);
  if (entry === undefined) {
    const known = shipped.manifest.stacks.map((s) => s.id).join(", ");
    throw new Error(`agent-context: no shipped tree for the stack "${id}" (shipped: ${known})`);
  }
  const from = `${shipped.manifest.docsLinkPrefix}${shipped.manifest.docsRef}/`;
  const to = `${shipped.manifest.docsLinkPrefix}${docsRef}/`;
  return entry.files.map((f) => {
    const contents = shipped.files.get(f.file);
    if (contents === undefined) throw new Error(`agent-context: the shipped tree is missing ${f.file}`);
    return { path: f.path, contents: contents.split(from).join(to) };
  });
}
