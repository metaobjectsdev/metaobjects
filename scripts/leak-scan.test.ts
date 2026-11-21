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

describe("identity scan (author and committer vs the private denylist)", () => {
  // Synthetic denylist and identities only; nothing here names a real person or employer.
  const deny = () => {
    const f = join(tmp, "deny.txt");
    writeFileSync(f, "# synthetic\nacmecorp\n");
    return f;
  };
  function identityFixture(): string {
    const dir = fixture();
    cpSync(join(REPO, ".githooks", "identity-scan.sh"), join(dir, ".githooks", "identity-scan.sh"));
    git(dir, "config", "hooks.denyListPath", deny());
    return dir;
  }
  function run(dir: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync("bash", [join(dir, ".githooks", "identity-scan.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }
  const bad = { GIT_AUTHOR_NAME: "Pat", GIT_AUTHOR_EMAIL: "pat@acmecorp.example" };
  const good = { GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "sam@example.com" };

  test("a denylisted author email blocks a commit and names only the role", () => {
    const dir = identityFixture();
    const r = run(dir, ["staged"], { ...good, ...bad });
    expect(r.status).toBe(1);
    expect(r.out).toContain("author");
    expect(r.out).not.toContain("committer");
    expect(r.out.toLowerCase()).not.toContain("acmecorp");
  });

  test("a denylisted committer name blocks a commit", () => {
    const dir = identityFixture();
    const r = run(dir, ["staged"], {
      GIT_AUTHOR_NAME: "Sam",
      GIT_AUTHOR_EMAIL: "sam@example.com",
      GIT_COMMITTER_NAME: "AcmeCorp Bot",
      GIT_COMMITTER_EMAIL: "bot@example.com",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("committer");
  });

  test("a clean identity passes, and so does no denylist at all", () => {
    const dir = identityFixture();
    const clean = { GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.com", ...good };
    expect(run(dir, ["staged"], clean).status).toBe(0);
    git(dir, "config", "hooks.denyListPath", join(tmp, "missing.txt"));
    expect(run(dir, ["staged"], { ...good, ...bad }).status).toBe(0);
  });

  test("the pre-commit hook refuses a denylisted identity", () => {
    const dir = identityFixture();
    cpSync(join(REPO, ".githooks", "pre-commit"), join(dir, ".githooks", "pre-commit"));
    const r = spawnSync("bash", [join(dir, ".githooks", "pre-commit")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...good, ...bad },
    });
    expect(r.status).toBe(1);
  });

  test("a range scan lists only the SHAs of commits with a denylisted identity", () => {
    const dir = identityFixture();
    writeFileSync(join(dir, "c.md"), "x\n");
    git(dir, "add", "-A");
    const env = { ...process.env, ...bad, ...good };
    const c = spawnSync("git", ["commit", "-q", "-m", "tainted"], { cwd: dir, env });
    expect(c.status).toBe(0);
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const r = run(dir, ["range", "HEAD~1..HEAD"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(sha);
    expect(r.out.toLowerCase()).not.toContain("acmecorp");
    expect(run(dir, ["range", "HEAD~1..HEAD~1"]).status).toBe(0);
  });

  test("a range that cannot be resolved blocks instead of passing", () => {
    const dir = identityFixture();
    const r = run(dir, ["range", `${"1".repeat(40)}..HEAD`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("push blocked");
  });

  describe("pre-push wiring", () => {
    const ZERO = "0".repeat(40);
    function pushFixture() {
      const dir = identityFixture();
      cpSync(join(REPO, ".githooks", "pre-push"), join(dir, ".githooks", "pre-push"));
      const rev = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      const base = rev();
      writeFileSync(join(dir, "c.md"), "x\n");
      git(dir, "add", "-A");
      return { dir, base, commit: (env: Record<string, string>) => {
        const c = spawnSync("git", ["commit", "-q", "-m", "next"], { cwd: dir, env: { ...process.env, ...env } });
        expect(c.status).toBe(0);
        return rev();
      } };
    }
    function push(dir: string, line: string) {
      const r = spawnSync("bash", [join(dir, ".githooks", "pre-push")], {
        cwd: dir,
        encoding: "utf8",
        input: `${line}\n`,
        env: { ...process.env, SKIP_TS_TYPECHECK: "1" },
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    }

    test("a new branch carrying a denylisted identity is refused", () => {
      const { dir, commit } = pushFixture();
      const head = commit({ ...bad, ...good });
      const r = push(dir, `refs/heads/x ${head} refs/heads/x ${ZERO}`);
      expect(r.status).toBe(1);
      expect(r.out).toContain(head);
    });

    test("an update carrying a denylisted identity is refused, a clean one passes", () => {
      const { dir, base, commit } = pushFixture();
      const head = commit({ ...bad, ...good });
      expect(push(dir, `refs/heads/main ${head} refs/heads/main ${base}`).status).toBe(1);
      expect(push(dir, `refs/heads/main ${base} refs/heads/main ${base}`).status).toBe(0);
    });

    test("an update whose remote sha is unknown locally is refused", () => {
      const { dir, commit } = pushFixture();
      const head = commit({ ...good, GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.com" });
      expect(push(dir, `refs/heads/main ${head} refs/heads/main ${"1".repeat(40)}`).status).toBe(1);
    });
  });

  test("no address is exempt: an identity the denylist names is refused", () => {
    const dir = identityFixture();
    writeFileSync(join(tmp, "deny.txt"), "dougmealing\n");
    const r = run(dir, ["staged"], {
      GIT_AUTHOR_NAME: "Doug",
      GIT_AUTHOR_EMAIL: "doug@dougmealing.com",
      ...good,
    });
    expect(r.status).toBe(1);
  });
});
