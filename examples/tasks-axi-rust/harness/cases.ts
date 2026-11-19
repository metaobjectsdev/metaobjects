// The invocations the differential harness compares, in three groups:
//   differential  — run through the real tasks-axi and tasks-axi-rs, outputs must be byte-identical
//   refusals      — run through tasks-axi-rs only; each must fail loudly and say why
// Every backlog is synthetic (see synthetic-backlog.ts).

import type { Invocation } from "./sandbox.js";
import { idsIn, mulberry32, syntheticBacklog } from "./synthetic-backlog.js";

export interface Case extends Invocation {
  name: string;
}

const BACKLOG = "backlog.md";

/** Read-path commands over one synthetic backlog. */
export function backlogCases(seed: number): Case[] {
  const text = syntheticBacklog({ seed });
  const ids = idsIn(text);
  const r = mulberry32(seed * 7919 + 13);
  const useFile = seed % 2 === 0;
  const base = (args: string[], name: string): Case => ({
    name: `seed${seed}/${name}`,
    args: useFile ? [...args, "--file", "docs/tasks.md"] : args,
    files: useFile ? { "docs/tasks.md": text } : { [BACKLOG]: text },
  });
  const repos = [...text.matchAll(/\(repo:\s*([^)]+)\)/g)].map((m) => (m[1] as string).trim()).filter(Boolean);
  const kinds = [...text.matchAll(/\(kind:\s*([^)]+)\)/g)].map((m) => (m[1] as string).trim()).filter(Boolean);
  const repo = repos[0] ?? "widgets";
  const kind = kinds[0] ?? "scout";
  const extras = "blocked,blocked_by,body,closed,created,delivery_state,deps,held,hold_kind,hold_reason,hold_until,links,priority";
  const cases: Case[] = [
    base(["list"], "list"),
    base(["list", "--state", "queued"], "list-queued"),
    base(["list", "--state=in_flight"], "list-in_flight"),
    base(["list", "--state", "done"], "list-done"),
    base(["list", "--state", "held"], "list-held"),
    base(["list", "--blocked"], "list-blocked"),
    base(["list", "--repo", repo], "list-repo"),
    base(["list", "--repo", "no-such-repo"], "list-repo-none"),
    base(["list", "--kind", kind], "list-kind"),
    base(["list", "--kind", "task"], "list-kind-task"),
    base(["list", "--limit", "0"], "list-limit0"),
    base(["list", "--limit", "1"], "list-limit1"),
    base(["list", "--limit=3"], "list-limit3"),
    base(["list", "--limit", "100"], "list-limit100"),
    base(["list", "--fields", extras], "list-allfields"),
    base(["list", "--fields", "body,body,priority, created"], "list-fields-dup"),
    base(["list", "--blocked", "--state", "held", "--fields", "hold_reason"], "list-combo-empty"),
    base(["list", "--state", "queued", "--repo", repo, "--kind", kind], "list-state-repo-kind"),
    base(["ready"], "ready"),
    base(["ready", "--include-held"], "ready-held"),
    base(["ready", "--repo", repo], "ready-repo"),
    base(["ready", "--repo", repo, "--include-held"], "ready-repo-held"),
    base(["ready", "--repo", "no-such-repo"], "ready-repo-none"),
    base(["show", "no-such-task"], "show-missing"),
  ];
  const picks = ids.length <= 10 ? ids : Array.from({ length: 10 }, () => ids[Math.floor(r() * ids.length)] as string);
  for (const id of new Set(picks)) {
    cases.push(base(["show", id], `show-${id}`));
    cases.push(base(["view", id, "--full"], `show-full-${id}`));
  }
  return cases;
}

const ONE_TASK = "# Backlog\n\n## Queued\n\n- [ ] one-a1 - The one task (repo: r1)\n";
const TWO_TASKS =
  "## In flight\n\n- [ ] dep-b2 - Blocker\n\n## Queued\n\n- [ ] user-c3 - Waits blocked-by: dep-b2\n  Body text\n";

/** Behaviour that does not depend on a backlog's content: parsing, errors, help, configuration. */
export function fixedCases(): Case[] {
  const f = (args: string[], name: string, extra: Partial<Case> = {}): Case => ({
    name: `fixed/${name}`,
    args,
    files: { [BACKLOG]: ONE_TASK },
    ...extra,
  });
  return [
    // version and help
    f(["--version"], "version"),
    f(["-v"], "version-v"),
    f(["-V"], "version-V"),
    f(["task", "--version"], "noun-version"),
    f(["list", "--help"], "help-list"),
    f(["show", "--help"], "help-show"),
    f(["view", "--help"], "help-view"),
    f(["ready", "--help"], "help-ready"),
    f(["task", "list", "--help"], "help-noun-list"),
    f(["list", "--bogus", "--help"], "help-wins"),
    f(["frobnicate", "--help"], "help-unknown"),
    // command-line errors
    f(["frobnicate"], "unknown-command"),
    f(["task", "frobnicate"], "unknown-command-noun"),
    f(["--foo", "list"], "leading-flag"),
    f(["-x"], "leading-short-flag"),
    f(["task", "--foo"], "leading-flag-noun"),
    f(["show"], "show-no-id"),
    f(["show", "one-a1", "two"], "show-two-ids"),
    f(["show", "--bogus", "one-a1"], "show-unknown-flag"),
    f(["show", "-x"], "show-short-flag"),
    f(["show", "bad id!"], "show-bad-id"),
    f(["show", ""], "show-empty-id"),
    f(["show", "   "], "show-blank-id"),
    f(["show", ".hidden"], "show-dot-id"),
    f(["show", "one-a1", "--full", "--full"], "show-full-twice"),
    f(["list", "--state", "bogus"], "list-bad-state"),
    f(["list", "--state"], "list-state-novalue"),
    f(["list", "--state", "--blocked"], "list-state-flaglike"),
    f(["list", "--limit", "-1"], "list-limit-negative"),
    f(["list", "--limit", "abc"], "list-limit-text"),
    f(["list", "--limit", "1.5"], "list-limit-float"),
    f(["list", "--limit", "99999999999999999999"], "list-limit-huge"),
    f(["list", "--limit", "9007199254740991"], "list-limit-maxsafe"),
    f(["list", "--limit", "9007199254740992"], "list-limit-unsafe"),
    f(["list", "--limit", "007"], "list-limit-leading-zero"),
    f(["list", "--fields", "nope,body"], "list-bad-field"),
    f(["list", "--fields", "id"], "list-field-already-default"),
    f(["list", "--fields="], "list-fields-empty"),
    f(["list", "--fields", " , ,"], "list-fields-blank"),
    f(["list", "--repo="], "list-repo-empty"),
    f(["list", "--repo", "a\nb"], "list-repo-multiline"),
    f(["list", "--repo"], "list-repo-novalue"),
    f(["list", "--kind", "  "], "list-kind-blank"),
    f(["list", "extra"], "list-positional"),
    f(["list", "--bogus"], "list-unknown-flag"),
    f(["list", "--blocked", "--blocked"], "list-blocked-twice"),
    f(["ready", "extra"], "ready-positional"),
    f(["ready", "--bogus"], "ready-unknown-flag"),
    f(["ready", "--repo", "r1", "--repo", "r2"], "ready-repo-twice"),
    // global flags and suggestion suffixes
    f(["list", "--backend", "markdown"], "backend-markdown"),
    f(["list", "--backend=markdown"], "backend-markdown-eq"),
    f(["list", "--backend", "sqlite"], "backend-unsupported"),
    f(["list", "--backend"], "backend-novalue"),
    f(["list", "--backend="], "backend-empty"),
    f(["list", "--file"], "file-novalue"),
    f(["list", "--file="], "file-empty"),
    f(["list", "--file", "a\nb"], "file-multiline"),
    f(["list", "--file", "missing.md"], "file-missing"),
    f(["list", "--file", "x y.md"], "file-space", { files: { "x y.md": ONE_TASK } }),
    f(["ready", "--file", "it's.md"], "file-quote", { files: { "it's.md": ONE_TASK } }),
    f(["list", "--file", "back`tick.md"], "file-backtick", { files: { "back`tick.md": ONE_TASK } }),
    f(["list", "--file", "a.md", "--file", "b.md"], "file-twice", { files: { "a.md": ONE_TASK, "b.md": TWO_TASKS } }),
    f(["show", "none", "--file", "a.md", "--backend", "markdown"], "notfound-globals", { files: { "a.md": ONE_TASK } }),
    f(["list", "--repo", "r1", "--file", "a.md"], "list-filter-and-globals", { files: { "a.md": ONE_TASK } }),
    f(["ready", "--repo", "x y", "--file", "a.md"], "ready-filter-quoted", { files: { "a.md": ONE_TASK } }),
    f(["--file", "a.md", "list"], "globals-before-command"),
    // file discovery and file content
    f(["list"], "discover-backlog", { files: { "backlog.md": ONE_TASK } }),
    f(["list"], "discover-data-backlog", { files: { "data/backlog.md": TWO_TASKS } }),
    f(["list"], "discover-prefers-root", { files: { "backlog.md": ONE_TASK, "data/backlog.md": TWO_TASKS } }),
    f(["list"], "no-backlog", { files: {} }),
    f(["ready"], "no-backlog-ready", { files: {} }),
    f(["list"], "empty-file", { files: { "backlog.md": "" } }),
    f(["list"], "only-newline", { files: { "backlog.md": "\n" } }),
    f(["list"], "preamble-only", { files: { "backlog.md": "# Backlog\n\nNothing here.\n" } }),
    f(["list"], "bom", { files: { "backlog.md": "﻿" + ONE_TASK } }),
    f(["list"], "invalid-utf8", {
      files: { "backlog.md": Buffer.concat([Buffer.from("## Queued\n\n- [ ] bad-a1 - caf"), Buffer.from([0xc3, 0x28, 0xff, 0xe2, 0x82]), Buffer.from(" tail\n")]) },
    }),
    f(["list"], "crlf", { files: { "backlog.md": ONE_TASK.replace(/\n/g, "\r\n") } }),
    f(["list"], "backlog-is-directory", { files: { "backlog.md/x": "y" } }),
    f(["show", "user-c3"], "show-blocked-hints", { files: { "backlog.md": TWO_TASKS } }),
    f(["show", "user-c3", "--file", "backlog.md"], "show-blocked-hints-globals", { files: { "backlog.md": TWO_TASKS } }),
    f(["list", "--blocked"], "list-blocked-fixed", { files: { "backlog.md": TWO_TASKS } }),
    // environment and config files
    f(["list"], "env-file", { env: { TASKS_AXI_FILE: "other.md" }, files: { "other.md": TWO_TASKS } }),
    f(["list"], "env-file-empty", { env: { TASKS_AXI_FILE: "" } }),
    f(["list", "--file", "backlog.md"], "flag-beats-env", { env: { TASKS_AXI_FILE: "other.md" }, files: { "other.md": TWO_TASKS, "backlog.md": ONE_TASK } }),
    f(["list"], "env-backend", { env: { TASKS_AXI_BACKEND: "linear" } }),
    f(["list"], "env-backend-empty", { env: { TASKS_AXI_BACKEND: "" } }),
    f(["list"], "toml-path", { files: { ".tasks.toml": '[markdown]\npath = "docs/t.md"\n', "docs/t.md": TWO_TASKS } }),
    f(["list"], "toml-path-single-quotes", { files: { ".tasks.toml": "[markdown]\npath = 'docs/t.md' # comment\n", "docs/t.md": TWO_TASKS } }),
    f(["list"], "toml-backend", { files: { ".tasks.toml": 'backend = "jira"\n' } }),
    f(["list"], "toml-backend-ok", { files: { ".tasks.toml": 'backend = "markdown"\n' } }),
    f(["list"], "toml-bad-line", { files: { ".tasks.toml": "nonsense\n" } }),
    f(["list"], "toml-bad-value", { files: { ".tasks.toml": "backend = markdown\n" } }),
    f(["list"], "toml-unterminated", { files: { ".tasks.toml": 'backend = "markdown\n' } }),
    f(["list"], "toml-backend-number", { files: { ".tasks.toml": "backend = 3\n" } }),
    f(["list"], "toml-done-keep-ok", { files: { ".tasks.toml": "[markdown]\ndone_keep = 3\n" } }),
    f(["list"], "toml-done-keep-negative", { files: { ".tasks.toml": "[markdown]\ndone_keep = -2\n" } }),
    f(["list"], "toml-done-keep-text", { files: { ".tasks.toml": '[markdown]\ndone_keep = "3"\n' } }),
    f(["list"], "toml-done-keep-huge", { files: { ".tasks.toml": "[markdown]\ndone_keep = 99999999999999999999\n" } }),
    f(["list"], "toml-path-empty", { files: { ".tasks.toml": '[markdown]\npath = ""\n' } }),
    f(["list"], "toml-other-table", { files: { ".tasks.toml": "[server]\nport = 1\nnonsense\n" } }),
    f(["list"], "toml-crlf", { files: { ".tasks.toml": '[markdown]\r\npath = "docs/t.md"\r\n', "docs/t.md": TWO_TASKS } }),
    f(["list"], "toml-archive-is-backlog", { files: { ".tasks.toml": '[markdown]\narchive = "backlog.md"\n' } }),
    f(["list"], "toml-archive-other", { files: { ".tasks.toml": '[markdown]\narchive = "old.md"\n' } }),
    f(["list"], "backlog-named-done-archive", { files: { ".tasks.toml": '[markdown]\npath = "done-archive.md"\n', "done-archive.md": ONE_TASK } }),
    f(["list"], "backlog-named-note-archive", { files: { ".tasks.toml": '[markdown]\npath = "note-archive.md"\n', "note-archive.md": ONE_TASK } }),
    f(["list"], "home-config-path", { home: { ".tasks-axi/config.toml": '[markdown]\npath = "h.md"\n' }, files: { "h.md": TWO_TASKS } }),
    f(["list"], "home-config-bad", { home: { ".tasks-axi/config.toml": "nonsense\n" } }),
    f(["list"], "project-beats-home", {
      home: { ".tasks-axi/config.toml": '[markdown]\npath = "h.md"\n' },
      files: { ".tasks.toml": '[markdown]\npath = "p.md"\n', "h.md": ONE_TASK, "p.md": TWO_TASKS },
    }),
    f(["list", "--file", "backlog.md"], "flag-beats-toml", { files: { ".tasks.toml": '[markdown]\npath = "p.md"\n', "p.md": TWO_TASKS, "backlog.md": ONE_TASK } }),
  ];
}

const REFUSED = ["add", "create", "start", "done", "close", "reopen", "update", "edit", "rm", "delete", "block", "unblock", "hold", "unhold", "public-followup", "mv", "prune", "render", "setup"];

/** Cases only tasks-axi-rs runs: it must refuse, loudly. */
export function refusalCases(): Case[] {
  const files = { [BACKLOG]: ONE_TASK };
  const cases: Case[] = REFUSED.map((c) => ({ name: `refuse/${c}`, args: [c, "x-1"], files }));
  cases.push({ name: "refuse/noun-add", args: ["task", "add", "x-1", "t"], files });
  cases.push({ name: "refuse/dashboard", args: [], files });
  cases.push({ name: "refuse/dashboard-noun", args: ["task"], files });
  const followup =
    "## Queued\n\n- [ ] pf-a1 - Needs a reply (kind: public-followup)\n  <!-- tasks-axi:public-followup/v1:eyJ4IjoxfQ -->\n- [ ] plain-b2 - Plain\n";
  for (const args of [["list"], ["ready"], ["show", "plain-b2"]]) {
    cases.push({ name: `refuse/public-followup-${args[0]}`, args, files: { [BACKLOG]: followup } });
  }
  return cases;
}
