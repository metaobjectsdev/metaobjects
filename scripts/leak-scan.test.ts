// The public-repo leak scan, exercised against a throwaway repository.
//
// `.githooks/leak-scan.sh` is the hosted `leak-scan` status and `.githooks/pre-commit` is the
// local hook; both read `.githooks/leak-patterns.sh`. Two defects (audit finding 12) let a
// leak through: `--diff-filter=ACM` skipped renamed-with-edits files, and the hosted scan had
// no `/Users/<name>/` pattern while the local hook did.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "leak-scan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function fixture(): string {
  const dir = mkdtempSync(join(tmp, "repo-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".githooks"));
  for (const f of ["leak-scan.sh", "leak-patterns.sh", "pre-commit"]) {
    cpSync(join(REPO, ".githooks", f), join(dir, ".githooks", f));
  }
  // Long enough that an edit stays above git's rename-similarity threshold.
  writeFileSync(join(dir, "a.md"), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function scan(dir: string, script = "leak-scan.sh") {
  const r = spawnSync("bash", [join(dir, ".githooks", script)], { cwd: dir, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Built from parts so this test file never trips the scan itself.
const mac = "/" + "Users" + "/someone/project";
const linux = "/" + "home" + "/someone/project";

describe("leak-scan", () => {
  test("clean staged change passes", () => {
    const dir = fixture();
    writeFileSync(join(dir, "a.md"), "line 0\nnothing here\n");
    git(dir, "add", "-A");
    expect(scan(dir).status).toBe(0);
  });

  test("an added /home path is blocked (existing behaviour)", () => {
    const dir = fixture();
    writeFileSync(join(dir, "b.md"), `see ${linux}\n`);
    git(dir, "add", "-A");
    expect(scan(dir).status).toBe(1);
  });

  test("an added macOS home path is blocked (previously only the local hook caught it)", () => {
    const dir = fixture();
    writeFileSync(join(dir, "b.md"), `see ${mac}\n`);
    git(dir, "add", "-A");
    const r = scan(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("someone");
  });

  test("a leak added while RENAMING a file is blocked", () => {
    const dir = fixture();
    git(dir, "mv", "a.md", "b.md");
    writeFileSync(
      join(dir, "b.md"),
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + `\nsee ${linux}\n`,
    );
    git(dir, "add", "-A");
    const names = spawnSync("git", ["diff", "--cached", "--name-status"], { cwd: dir, encoding: "utf8" }).stdout;
    expect(names).toMatch(/^R/);
    expect(scan(dir).status).toBe(1);
  });

  test("the local pre-commit hook agrees with the hosted scan", () => {
    const dir = fixture();
    writeFileSync(join(dir, "b.md"), `see ${mac}\n`);
    git(dir, "add", "-A");
    expect(scan(dir, "pre-commit").status).toBe(1);
  });
});
