import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_NAMES, type AssembledFile, type Stack } from "./types.js";

interface ServerMeta { displayName: string; install: string; codegenCommand: string; }

function readServerMeta(contentRoot: string, server: string): ServerMeta | undefined {
  const p = join(contentRoot, "servers", `${server}.meta.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as ServerMeta;
}

function stackLine(contentRoot: string, stack: Stack): { line: string; codegenCommand: string } {
  const primary = stack.servers[0];
  const meta = primary ? readServerMeta(contentRoot, primary) : undefined;
  const serverPart = stack.servers.length ? stack.servers.join(", ") + " server" : "no server";
  const clientPart = stack.clients.length ? stack.clients.join(", ") + " client" : "no client";
  return {
    line: `Stack: ${serverPart}, ${clientPart}; migrations are TS.`,
    codegenCommand: meta ? meta.codegenCommand : "meta gen",
  };
}

function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`agent-context: unknown template variable {{${k}}}`);
    return vars[k]!;
  });
}

/** Assemble the consumer files for a resolved stack. Pure given the content tree. */
export function assemble(opts: { contentRoot: string; stack: Stack }): AssembledFile[] {
  const { contentRoot, stack } = opts;
  const out: AssembledFile[] = [];

  // 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
  const tpl = readFileSync(join(contentRoot, "templates", "always-on.md.mustache"), "utf8");
  const { line, codegenCommand } = stackLine(contentRoot, stack);
  const alwaysOn = applyTemplate(tpl, { stackLine: line, codegenCommand });
  out.push({ path: ".metaobjects/AGENTS.md", contents: alwaysOn });
  out.push({ path: ".metaobjects/CLAUDE.md", contents: alwaysOn });

  // 2. Skills: body + only the references whose token is in the stack.
  for (const skill of SKILL_NAMES) {
    const skillDir = join(contentRoot, "skills", skill);
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    out.push({ path: `.claude/skills/${skill}/SKILL.md`, contents: body });

    const refDir = join(skillDir, "references");
    if (existsSync(refDir) && statSync(refDir).isDirectory()) {
      const refs = readdirSync(refDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .filter((token) => stack.tokens.has(token))
        .sort();
      for (const token of refs) {
        out.push({
          path: `.claude/skills/${skill}/references/${token}.md`,
          contents: readFileSync(join(refDir, `${token}.md`), "utf8"),
        });
      }
    }
  }

  // Stable order: by path.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
