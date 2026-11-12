import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pinDocsRefs } from "@metaobjectsdev/metadata";
import {
  SKILL_NAMES, SERVER_LANGS, CLIENT_FRAMEWORKS, type AssembledFile, type Stack,
} from "./types.js";

// Language/framework reference fragments are stack-scoped, and so is a `<token>-<topic>.md`
// split out of one; any other fragment (capability-checklist, requirements, ...) is universal
// and always installs. The requirements pages used to be gated on the project declaring a
// `requirement.*` node, observed when `meta init` ran — which is before a new project has
// written any, so the pages a project needed once it did were never installed and nothing
// said so. A page on disk costs nothing until it is opened.
const SCOPED_FRAGMENT_TOKENS = new Set<string>([...SERVER_LANGS, ...CLIENT_FRAMEWORKS]);

/**
 * The stack token a fragment is scoped by, or undefined for a universal fragment.
 * `typescript.md` and a topic split out of it, `typescript-retargeting.md`, are both scoped
 * by `typescript`; `capability-checklist.md` names no token and always installs.
 */
function fragmentScope(name: string): string | undefined {
  if (SCOPED_FRAGMENT_TOKENS.has(name)) return name;
  const dash = name.indexOf("-");
  const prefix = dash > 0 ? name.slice(0, dash) : undefined;
  return prefix !== undefined && SCOPED_FRAGMENT_TOKENS.has(prefix) ? prefix : undefined;
}

interface ServerMeta {
  displayName: string;
  install: string;
  codegenCommand: string;
  /** The "before you call it done" line for this port: its own drift gate, which also runs the
   *  requirement gate. Markdown, no trailing period. */
  verifyStep: string;
}

function readServerMeta(contentRoot: string, server: string): ServerMeta | undefined {
  const p = join(contentRoot, "servers", `${server}.meta.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as ServerMeta;
}

/** Describe only what the stack declares — never a migration binding (the tool states
 *  invariants; the project states bindings). See issue #1. */
function stackLine(stack: Stack): string {
  const serverPart = stack.servers.length ? stack.servers.join(", ") + " server" : "no server";
  const clientPart = stack.clients.length ? stack.clients.join(", ") + " client" : "no client";
  return `Stack: ${serverPart}, ${clientPart}.`;
}

/** What the loop says when the stack declares nothing it could give a generate step for. */
const NO_STACK_LOOP =
  "No server language is declared for this project, so this file names no generate step. " +
  "Declare it and refresh: `meta init --docs-only --refresh-docs --server " +
  "<typescript|java|kotlin|csharp|python>`.\n\n";

/**
 * The working loop's generate steps, one fragment per declared server
 * (`templates/loops/<server>.md`, in SERVER_LANGS order) plus the web-client fragment when the
 * stack declares a client. A polyglot stack gets each of its ports; a stack gets none it does
 * not declare, so a Python project is never told to edit a `metaobjects.config.ts`.
 */
function stackLoops(contentRoot: string, stack: Stack): string {
  const parts = stack.servers.map((s) => readFileSync(join(contentRoot, "templates", "loops", `${s}.md`), "utf8"));
  if (stack.clients.length > 0) parts.push(readFileSync(join(contentRoot, "templates", "loops", "client.md"), "utf8"));
  return parts.length > 0 ? parts.join("\n") : NO_STACK_LOOP;
}

/** One "before you call it done" bullet per declared server, and one for a web client generated
 *  by the Node CLI when no TypeScript server already covers it. */
function verifySteps(contentRoot: string, stack: Stack): string {
  const lines: string[] = [];
  for (const s of stack.servers) {
    const meta = readServerMeta(contentRoot, s);
    // Java and Kotlin share one Maven goal; say it once.
    const line = meta === undefined ? undefined : `- ${meta.verifyStep}.\n`;
    if (line !== undefined && !lines.includes(line)) lines.push(line);
  }
  if (stack.clients.length > 0 && !stack.servers.includes("typescript")) {
    lines.push("- `npx meta verify --codegen` (the generated web client).\n");
  }
  return lines.join("");
}

/**
 * Substitute `{{var}}` and the two section forms `{{#name}}…{{/name}}` (render when the
 * flag is true) and `{{^name}}…{{/name}}` (render when it is false).
 *
 * Sections do NOT nest — one pass, non-greedy to the matching close tag — which is all the
 * always-on template needs. An unknown variable or section name THROWS, and so does any
 * section tag left standing after the pass (mistyped close tag, unclosed section, nesting):
 * a silently empty substitution, or a literal `{{#…}}` shipped into a file an agent is told
 * to trust, is the failure this whole surface exists to prevent.
 */
function applyTemplate(
  tpl: string,
  vars: Record<string, string>,
  sections: Record<string, boolean>,
): string {
  const resolved = tpl.replace(
    /\{\{([#^])(\w+)\}\}\n?([\s\S]*?)\{\{\/\2\}\}\n?/g,
    (_m, sigil: string, name: string, body: string) => {
      if (!(name in sections)) {
        throw new Error(`agent-context: unknown template section {{${sigil}${name}}}`);
      }
      // `#` shows its body when the flag is true, `^` when it is false.
      const shownWhen = sigil === "#";
      return sections[name] === shownWhen ? body : "";
    },
  );
  // A section tag that SURVIVED the pass above is malformed — a mistyped close tag, an
  // unclosed section, or a nested one (the single non-greedy pass matches the first close
  // tag, leaving the inner pair behind). Every one of those would otherwise ship a literal
  // `{{#…}}` into a file an agent is told to trust, which is the failure this mechanism
  // exists to prevent, so the leftover is an ERROR rather than passed through. The
  // variable pass below cannot catch it: `{{#a}}` is not a `\w+` match.
  const leftover = resolved.match(/\{\{[#^/]\w*\}\}/);
  if (leftover !== null) {
    throw new Error(
      `agent-context: unresolved template section tag ${leftover[0]} — a section must be a ` +
        "well-formed {{#name}}…{{/name}} or {{^name}}…{{/name}} pair, and sections do not nest",
    );
  }
  return resolved.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`agent-context: unknown template variable {{${k}}}`);
    return vars[k]!;
  });
}

/**
 * Assemble the consumer files for a resolved stack. Pure given the content tree.
 *
 * `docsRef` is the git ref every guide link in the shipped prose points at (default
 * `main`, which is what the content tree is authored with). The scaffolder passes the tag
 * of the running release (`docsRefForVersion`), so the links an agent follows are the
 * guides of the version that wrote them and do not move after the cut.
 */
export function assemble(opts: { contentRoot: string; stack: Stack; docsRef?: string }): AssembledFile[] {
  const { contentRoot, stack } = opts;
  const docsRef = opts.docsRef ?? "main";
  const out: AssembledFile[] = [];

  // 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
  const tpl = readFileSync(join(contentRoot, "templates", "always-on.md.mustache"), "utf8");
  const alwaysOn = applyTemplate(
    tpl,
    { stackLine: stackLine(stack), stackLoops: stackLoops(contentRoot, stack), verifySteps: verifySteps(contentRoot, stack) },
    {},
  );
  out.push({ path: ".metaobjects/AGENTS.md", contents: alwaysOn });
  out.push({ path: ".metaobjects/CLAUDE.md", contents: alwaysOn });

  // 2. Skills: body + only the references whose token is in the stack.
  for (const skill of SKILL_NAMES) {
    const skillDir = join(contentRoot, "skills", skill);
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    out.push({ path: `.claude/skills/${skill}/SKILL.md`, contents: body });

    const refDir = join(skillDir, "references");
    if (existsSync(refDir) && statSync(refDir).isDirectory()) {
      // Stack-scoped: a language/framework fragment installs only when its
      // token is in the resolved stack (Stack.tokens = servers ∪ clients ∪ {migration}). Non-scoped fragments (e.g. capability-checklist) are
      // universal and always install. Keeps each skill's references/ to what the
      // project actually uses, so the SKILL.md "read every references/*.md" footer
      // stays accurate.
      const refs = readdirSync(refDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .sort();
      for (const token of refs) {
        const scope = fragmentScope(token);
        if (scope !== undefined && !stack.tokens.has(scope)) continue;
        out.push({
          path: `.claude/skills/${skill}/references/${token}.md`,
          contents: readFileSync(join(refDir, `${token}.md`), "utf8"),
        });
      }
    }
  }

  // Stable order: by path.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.map((f) => ({ ...f, contents: pinDocsRefs(f.contents, docsRef) }));
}
