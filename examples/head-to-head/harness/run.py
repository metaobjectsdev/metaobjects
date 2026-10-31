#!/usr/bin/env python3
"""Run every drift scenario against both setups and write SCORECARD.md.

Nothing in the scorecard's result cells is typed by hand: each one is computed from the
exit codes of the checks the scenario ran. Standard library only (Python 3.9+).
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lines  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SETUPS = ("baseline", "metaobjects")
LABEL = {"baseline": "DIY baseline", "metaobjects": "MetaObjects"}
PG_IMAGE = "postgres:16"
ATLAS_IMAGE = "arigaio/atlas:1.3.6-community"
OASDIFF_IMAGE = "tufin/oasdiff:v1.35.0"
TIMEOUT = 600


def log(msg: str) -> None:
    print(f"[h2h] {msg}", flush=True)


# --------------------------------------------------------------------------- shell


def sh(cmd: str | list[str], cwd: Path, env: dict[str, str] | None = None,
       timeout: int = TIMEOUT) -> subprocess.CompletedProcess:
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, cwd=cwd, env=full_env, shell=isinstance(cmd, str), text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)


# --------------------------------------------------------------------------- postgres


class Postgres:
    def __init__(self) -> None:
        self.name = f"h2h-pg-{uuid.uuid4().hex[:8]}"
        out = subprocess.run(
            ["docker", "run", "-d", "--rm", "--name", self.name, "-e", "POSTGRES_PASSWORD=h2h",
             "-p", "127.0.0.1::5432", PG_IMAGE], text=True, capture_output=True)
        if out.returncode != 0:
            raise SystemExit(f"could not start Postgres:\n{out.stderr}")
        atexit.register(self.stop)
        port = subprocess.run(["docker", "port", self.name, "5432/tcp"], text=True, capture_output=True)
        self.port = port.stdout.strip().rsplit(":", 1)[1]
        for _ in range(120):
            logs = subprocess.run(["docker", "logs", self.name], text=True, capture_output=True)
            ready = (logs.stdout + logs.stderr).count("ready to accept connections")
            if ready >= 2 and self.psql("select 1").returncode == 0:
                return
            time.sleep(0.5)
        raise SystemExit("Postgres did not become ready")

    def psql(self, sql: str, db: str = "postgres") -> subprocess.CompletedProcess:
        return subprocess.run(["docker", "exec", self.name, "psql", "-U", "postgres", "-d", db,
                               "-v", "ON_ERROR_STOP=1", "-tAc", sql], text=True, capture_output=True)

    def fresh_db(self, name: str) -> str:
        r = self.psql(f'CREATE DATABASE "{name}"')
        if r.returncode != 0:
            raise SystemExit(f"create database {name}: {r.stderr}")
        return name

    def stop(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)

    def env(self, **extra: str) -> dict[str, str]:
        return {"H2H_PG_CONTAINER": self.name, "H2H_PG_PORT": self.port, **extra}


# --------------------------------------------------------------------------- workdir


class Work:
    """A throwaway copy of one setup, committed as the base branch, where a scenario edits."""

    def __init__(self, setup: str, scenario: str, pg: Postgres, tmp: Path) -> None:
        self.setup, self.scenario, self.pg = setup, scenario, pg
        self.path = tmp / f"{setup}-{scenario}"
        src = ROOT / setup
        shutil.copytree(src, self.path, symlinks=True, ignore=shutil.ignore_patterns(
            "node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ci-logs"))
        for dep in ("node_modules", ".venv"):
            (self.path / dep).symlink_to(src / dep)
        git = ["git", "-c", "user.name=h2h", "-c", "user.email=h2h@example.test"]
        self.git = git
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.path, check=True)
        subprocess.run([*git, "add", "-A"], cwd=self.path, check=True)
        subprocess.run([*git, "commit", "-qm", "base"], cwd=self.path, check=True)
        self.dev_log: list[dict] = []
        self.uid = f"{setup[:2]}_{scenario.lower()}"

    def env(self, **extra: str) -> dict[str, str]:
        return self.pg.env(**extra)

    def edit(self, rel: str, old: str, new: str) -> None:
        p = self.path / rel
        text = p.read_text(encoding="utf-8")
        if text.count(old) != 1:
            raise SystemExit(f"{self.setup}/{rel}: expected exactly one match for {old!r}, found {text.count(old)}")
        p.write_text(text.replace(old, new), encoding="utf-8")

    def dev(self, cmd: str) -> None:
        """A command the developer runs while making the change (their own generators)."""
        r = sh(cmd, self.path, self.env())
        self.dev_log.append({"cmd": cmd, "rc": r.returncode, "output": r.stdout})

    def commit(self) -> None:
        subprocess.run([*self.git, "add", "-A"], cwd=self.path, check=True)
        subprocess.run([*self.git, "commit", "-qm", "change", "--allow-empty"], cwd=self.path, check=True)

    def db(self, tag: str) -> str:
        return self.pg.fresh_db(f"{self.uid}_{tag}")


# --------------------------------------------------------------------------- scenarios


@dataclass
class Scenario:
    id: str
    title: str
    what: str
    kind: str  # "pr" runs the pull-request gate; "live" runs the live-database drift check
    change: dict[str, Callable[[Work], None]] = field(default_factory=dict)


def no_change(w: Work) -> None:
    pass


def s1_baseline(w: Work) -> None:
    w.edit("spec/main.tsp", "  id: int64;\n\n  @maxLength(320)\n  email: string;",
           "  id: int64;\n\n  @maxLength(320)\n  contactEmail: string;")
    w.edit("spec/main.tsp", "  @minLength(1)\n  @maxLength(320)\n  email: string;",
           "  @minLength(1)\n  @maxLength(320)\n  contactEmail: string;")
    w.edit("spec/main.tsp", '"name" | "email" | "plan"', '"name" | "contactEmail" | "plan"')
    w.dev("./gen.sh")


def s1_metaobjects(w: Work) -> None:
    w.edit("metaobjects/meta.crm.yaml", "name: email, maxLength: 320", "name: contactEmail, maxLength: 320")
    w.edit("metaobjects/meta.crm.yaml", "extends: Customer.email", "extends: Customer.contactEmail")
    w.dev("npx meta gen")
    w.dev(".venv/bin/metaobjects gen")
    w.dev("npx meta migrate --slug rename-email --rename-column customers.email=contact_email")


def s2_baseline(w: Work) -> None:
    w.edit("spec/main.tsp", "  plan: Plan;\n  createdAt", "  plan: Plan;\n\n  @maxLength(2)\n  country: string;\n\n  createdAt")
    w.edit("spec/main.tsp", "  plan?: Plan = Plan.free;", "  plan?: Plan = Plan.free;\n\n  @maxLength(2)\n  country: string;")
    w.dev("./gen.sh")


def s2_metaobjects(w: Work) -> None:
    w.edit("metaobjects/meta.crm.yaml", "          - field.timestamp:",
           "          - field.string: { name: country, maxLength: 2, required: true }\n          - field.timestamp:")
    w.dev("npx meta gen")
    w.dev(".venv/bin/metaobjects gen")
    w.dev("npx meta migrate --slug add-country")


def s3(w: Work) -> None:
    w.edit("prompts/welcome/greeting.jinja", "{{ name }}", "{{ fullName }}")


def s4_baseline(w: Work) -> None:
    w.edit("spec/main.tsp", "  plan: Plan;\n  createdAt", "  plan: Plan;\n\n  @maxLength(100)\n  nickname?: string;\n\n  createdAt")


def s4_metaobjects(w: Work) -> None:
    w.edit("metaobjects/meta.crm.yaml", "          - field.timestamp:",
           "          - field.string: { name: nickname, maxLength: 100 }\n          - field.timestamp:")


def s5(w: Work) -> None:  # the edit happens in the database, see run_scenario
    pass


def s6_baseline(w: Work) -> None:
    w.edit("spec/main.tsp", "  @maxLength(200)\n  name?: string;\n\n  plan?: Plan = Plan.free;",
           "  @maxLength(200)\n  name: string;\n\n  plan?: Plan = Plan.free;")
    w.dev("./gen.sh")


def s6_metaobjects(w: Work) -> None:
    w.edit("metaobjects/meta.crm.yaml", "{ name: name, maxLength: 200 }", "{ name: name, maxLength: 200, required: true }")
    w.dev("npx meta gen")
    w.dev(".venv/bin/metaobjects gen")
    w.dev("npx meta migrate --slug name-required --allow nullable-to-not-null")


SCENARIOS = [
    Scenario("S0", "Control: no change", "Nothing is edited. Every check must pass, so a red cell elsewhere is not noise from the setup itself.",
             "pr", {"baseline": no_change, "metaobjects": no_change}),
    Scenario("S1", "Rename a field", "`Customer.email` becomes `contactEmail` in the place each setup treats as its source of truth, then that setup's own generators run. The prompt payload, the database column and the hand-written code are left as they were.",
             "pr", {"baseline": s1_baseline, "metaobjects": s1_metaobjects}),
    Scenario("S2", "Add a required field", "`Customer` gains a required `country` (2 characters). Generators run; nothing else is touched.",
             "pr", {"baseline": s2_baseline, "metaobjects": s2_metaobjects}),
    Scenario("S3", "Change a prompt variable", "The prompt template is edited to use `{{ fullName }}`, which the payload does not have. Nothing is regenerated.",
             "pr", {"baseline": s3, "metaobjects": s3}),
    Scenario("S4", "Skip a regen", "An optional `nickname` field is added to the model and no generator is run, so the committed generated files are stale.",
             "pr", {"baseline": s4_baseline, "metaobjects": s4_metaobjects}),
    Scenario("S5", "Edit the database by hand", "Someone runs `ALTER TABLE customers ADD COLUMN vip boolean NOT NULL DEFAULT false` on a live database. The check is each setup's live-database drift command, the one a team runs on a schedule or at deploy time.",
             "live", {"baseline": s5, "metaobjects": s5}),
    Scenario("S6", "Change a field on the partner API", "`name` becomes required on `POST /customers`: a request partners send today without it would be rejected. Generators run; the database follows where the setup derives it.",
             "pr", {"baseline": s6_baseline, "metaobjects": s6_metaobjects}),
]

# What a "check" is named in the scorecard grid, by setup, in run order.
CHECKS = {
    "baseline": ["generated-in-sync", "api-compat", "atlas-migrations", "atlas-lint", "tsc", "mypy", "prompt-render"],
    "metaobjects": ["meta-verify", "metaobjects-verify", "meta-verify-db", "tsc", "mypy"],
}
CHECK_NOTE = {
    "generated-in-sync": "regenerate, then `git diff --exit-code`",
    "api-compat": "oasdiff against the released OpenAPI document",
    "atlas-migrations": "Atlas: migrations match `schema.sql`",
    "atlas-lint": "Atlas migration lint",
    "tsc": "TypeScript typecheck",
    "mypy": "mypy with the pydantic plugin",
    "prompt-render": "pytest render of the prompt with `StrictUndefined`",
    "meta-verify": "`meta verify` (codegen, templates, requirement links)",
    "metaobjects-verify": "`metaobjects verify` (Python codegen and templates)",
    "meta-verify-db": "CI database from the migrations, then `meta verify --db`",
}


# --------------------------------------------------------------------------- results


# A check that asks "does this break callers?" rather than "do the layers agree?". The two are scored apart.
COMPAT_CHECKS = {"api-compat"}


@dataclass
class Outcome:
    scenario: Scenario
    setup: str
    gate_rc: int | None = None
    checks: dict[str, tuple[bool, str]] = field(default_factory=dict)  # name -> (ok, evidence)
    smoke: tuple[bool, str] | None = None
    dev_notes: list[str] = field(default_factory=list)  # what the setup's own generators said while the change was made
    seconds: float = 0.0

    @property
    def layer_failed(self) -> list[str]:
        return [n for n, (ok, _) in self.checks.items() if not ok and n not in COMPAT_CHECKS]

    @property
    def compat_failed(self) -> bool:
        return any(not ok for n, (ok, _) in self.checks.items() if n in COMPAT_CHECKS)

    @property
    def has_compat_check(self) -> bool:
        return any(n in COMPAT_CHECKS for n in CHECKS[self.setup])

    @property
    def clean_gate(self) -> bool:
        return self.gate_rc in (0, None)


def clean(text: str, work: Path | None = None) -> str:
    """Drop local paths from a log line so the scorecard carries none."""
    if work is not None:
        text = text.replace(str(work), ".")
    text = re.sub(r"/(?:home|Users|tmp|var)/[^\s:'\"]+", "<path>", text)
    text = re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:<port>", text)
    return re.sub(r"\s+", " ", text).strip()


NOISE_RE = re.compile(r"Notice:|Atlas edition|advanced database objects|install the non-community|curl -sSf|"
                      r"Or, visit|^notRepresented|FutureWarning|warn_deprecated|^\s*$|antiPatterns|status: ran|"
                      r"total: 0|rows: \[\]|^help\[|^exitCode|^summary|^verify\[|^\s+(templates|schema|codegen|deps|requirements|replay),|"
                      r"running --codegen|not run:|^command:|^dialect:|^displayUrl:|^dryRun:|^pending\[|^applied\[", re.IGNORECASE)
GENERIC_RE = re.compile(r"error|ERR_|fail|breaking|differ|drift|stale|undefined|not found|no longer|drop|would|mismatch|warn",
                        re.IGNORECASE)


def _lines(text: str) -> list[str]:
    return [ln.rstrip() for ln in text.splitlines() if not NOISE_RE.search(ln)]


def _generic(text: str) -> str:
    cand = _lines(text)
    return next((ln for ln in cand if GENERIC_RE.search(ln)), cand[-1] if cand else "")


def _api_compat(text: str) -> str:
    ls = [ln.strip() for ln in text.splitlines()]
    head = next((ln for ln in ls if re.match(r"\d+ changes?:", ln)), "")
    for i, ln in enumerate(ls):
        m = re.match(r"error\s+\[(.+?)\]", ln)
        if m:
            where = ls[i + 1] if i + 1 < len(ls) else ""
            what = ls[i + 2] if i + 2 < len(ls) else ""
            return f"oasdiff: {head}; first: [{m.group(1)}] {where.removeprefix('in ')}: {what}"
    return head or _generic(text)


def _in_sync(text: str) -> str:
    files = re.findall(r"^diff --git a/(\S+) b/", text, re.MULTILINE)
    return ("a fresh regeneration differs from the committed " + ", ".join(f"`{f}`" for f in files)) if files else _generic(text)


def _prompt_render(text: str) -> str:
    errs = [ln[1:].strip() for ln in text.splitlines() if ln.startswith("E ")]
    return " ".join(errs[:2]) if errs else _generic(text)


def _first_match(rx: str):
    pat = re.compile(rx)
    def f(text: str) -> str:
        return next((ln for ln in text.splitlines() if pat.search(ln)), "") or _generic(text)
    return f


def _meta_verify(text: str) -> str:
    keep = [ln[6:].strip() for ln in text.splitlines()
            if ln.startswith("meta:") and re.search(r"ERR_|drift|differ|~ |\+ |- ", ln)
            and not re.search(r"not run|running --|compared against|no codegen drift|current", ln)]
    return "; ".join(keep[:3]) if keep else _generic(text)


def _python_verify(text: str) -> str:
    keep = [ln.strip() for ln in text.splitlines() if re.match(r"\s*(error:|drifted:)", ln)]
    return " ".join(keep[:2]) if keep else _generic(text)


def _smoke(text: str) -> str:
    ls = text.splitlines()
    probe = next((ln for ln in ls if ln.startswith("probe:")), "")
    if probe:
        return probe
    err = next((ln for ln in ls if re.match(r"(\w+\.)*\w*(Error|Exception)\b", ln) or ln.startswith("Error:")), "")
    if err.startswith("pydantic"):  # the field name is on the next lines
        i = ls.index(err)
        return " ".join(x.strip() for x in ls[i:i + 3] if x.strip())
    return err or _generic(text)


EXTRACT = {
    "generated-in-sync": _in_sync,
    "api-compat": _api_compat,
    "tsc": _first_match(r"error TS"),
    "mypy": _first_match(r"error:"),
    "prompt-render": _prompt_render,
    "meta-verify": _meta_verify,
    "metaobjects-verify": _python_verify,
    "meta-verify-db": _meta_verify,
    "live-drift": lambda t: _meta_verify(t) if "meta:" in t else (
        "atlas would change the live database with: " + " ".join(ln.strip() for ln in t.splitlines()
                                                                if re.match(r"(ALTER|CREATE|DROP)", ln))),
    "smoke": _smoke,
}


def evidence(name: str, text: str, work: Path) -> str:
    out = EXTRACT.get(name, _generic)(text)
    out = clean(out, work)
    return out if len(out) <= 200 else out[:199] + "…"


def read_log(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def run_scenario(sc: Scenario, setup: str, pg: Postgres, tmp: Path) -> Outcome:
    t0 = time.time()
    out = Outcome(sc, setup)
    w = Work(setup, sc.id, pg, tmp)
    sc.change[setup](w)
    for d in w.dev_log:
        warn = next((ln for ln in _lines(d["output"]) if re.search("warn", ln, re.I)), "")
        note = evidence("dev", d["output"], w.path) if d["rc"] != 0 else clean(warn, w.path)[:200]
        if d["rc"] != 0:
            out.dev_notes.append(f"`{d['cmd']}` exited {d['rc']}: {note}")
        elif note:
            out.dev_notes.append(f"`{d['cmd']}` printed: {note}")
    w.commit()
    logs = w.path / ".ci-logs"
    logs.mkdir(exist_ok=True)
    for i, d in enumerate(w.dev_log):
        (logs / f"authoring-{i + 1}.log").write_text(f"$ {d['cmd']}\n(exit {d['rc']})\n{d['output']}", encoding="utf-8")

    if sc.kind == "pr":
        ci_db = w.db("ci")
        r = sh("./ci.sh", w.path, w.env(H2H_DEV_DB=ci_db))
        out.gate_rc = r.returncode
        for line in r.stdout.splitlines():
            m = re.match(r"CHECK (\S+) (ok|fail)", line)
            if m:
                name, ok = m.group(1), m.group(2) == "ok"
                out.checks[name] = (ok, "" if ok else evidence(name, read_log(logs / f"{name}.log"), w.path))
        smoke_db = w.db("smoke")
        app = sh("./db-apply.sh", w.path, w.env(H2H_DB=smoke_db, H2H_DEV_DB=smoke_db))
        (logs / "db-apply.log").write_text(app.stdout, encoding="utf-8")
        if app.returncode != 0:
            out.smoke = (False, "the committed migrations did not apply: " + evidence("dev", app.stdout, w.path))
        else:
            s = sh("./smoke.sh", w.path, w.env(H2H_DB=smoke_db))
            (logs / "smoke.log").write_text(s.stdout, encoding="utf-8")
            out.smoke = (s.returncode == 0, "" if s.returncode == 0 else evidence("smoke", s.stdout, w.path))
    else:  # live-database drift
        live_db = w.db("live")
        app = sh("./db-apply.sh", w.path, w.env(H2H_DB=live_db, H2H_DEV_DB=w.db("dev")))
        if app.returncode != 0:
            raise SystemExit(f"{setup}: could not provision the live database:\n{app.stdout}")
        edit = pg.psql("ALTER TABLE customers ADD COLUMN vip boolean NOT NULL DEFAULT false", live_db)
        if edit.returncode != 0:
            raise SystemExit(f"hand edit failed: {edit.stderr}")
        r = sh("./live-drift.sh", w.path, w.env(H2H_DB=live_db, H2H_DEV_DB=w.db("devcheck")))
        (logs / "live-drift.log").write_text(r.stdout, encoding="utf-8")
        out.gate_rc = r.returncode
        out.checks["live-drift"] = (r.returncode == 0, "" if r.returncode == 0 else evidence("live-drift", r.stdout, w.path))
    out.seconds = time.time() - t0
    return out


# --------------------------------------------------------------------------- versions


def first_line(cmd: str | list[str], cwd: Path) -> str:
    try:
        r = sh(cmd, cwd, timeout=120)
        return next((ln.strip() for ln in r.stdout.splitlines() if ln.strip()), "?")
    except Exception as exc:  # noqa: BLE001
        return f"? ({exc.__class__.__name__})"


def npm_version(setup: str, pkg: str) -> str:
    p = ROOT / setup / "node_modules" / pkg / "package.json"
    import json as _json
    return _json.loads(p.read_text())["version"] if p.exists() else "?"


def py_version(setup: str, dist: str) -> str:
    return first_line([str(ROOT / setup / ".venv/bin/python"), "-c",
                       f"import importlib.metadata as m; print(m.version('{dist}'))"], ROOT)


def collect_versions(pg: Postgres) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    add = lambda scope, tool, ver: rows.append((scope, tool, ver))  # noqa: E731
    add("both", "Node.js", first_line("node --version", ROOT))
    add("both", "npm", first_line("npm --version", ROOT))
    add("both", "Python (venv)", first_line([str(ROOT / "baseline/.venv/bin/python"), "--version"], ROOT).replace("Python ", ""))
    add("both", "uv", first_line("uv --version", ROOT).replace("uv ", ""))
    add("both", "Docker", first_line("docker --version", ROOT).replace("Docker version ", "").split(",")[0])
    add("both", "PostgreSQL", pg.psql("show server_version").stdout.strip() + f" ({PG_IMAGE})")
    add("both", "TypeScript", npm_version("baseline", "typescript"))
    add("both", "Fastify", npm_version("baseline", "fastify"))
    add("both", "mypy", py_version("baseline", "mypy"))
    add("both", "pydantic", py_version("baseline", "pydantic"))
    add("baseline", "TypeSpec compiler", npm_version("baseline", "@typespec/compiler"))
    add("baseline", "@typespec/openapi3", npm_version("baseline", "@typespec/openapi3"))
    add("baseline", "openapi-typescript", npm_version("baseline", "openapi-typescript"))
    add("baseline", "datamodel-code-generator", py_version("baseline", "datamodel-code-generator"))
    add("baseline", "Atlas (community)", f"{ATLAS_IMAGE} ({first_line(['docker', 'run', '--rm', ATLAS_IMAGE, 'version'], ROOT)})")
    add("baseline", "oasdiff", f"{OASDIFF_IMAGE} ({first_line(['docker', 'run', '--rm', OASDIFF_IMAGE, '--version'], ROOT)})")
    add("baseline", "Jinja2", py_version("baseline", "jinja2"))
    add("baseline", "pytest", py_version("baseline", "pytest"))
    add("metaobjects", "@metaobjectsdev/cli", npm_version("metaobjects", "@metaobjectsdev/cli"))
    add("metaobjects", "@metaobjectsdev/codegen-ts", npm_version("metaobjects", "@metaobjectsdev/codegen-ts"))
    add("metaobjects", "metaobjects (PyPI)", py_version("metaobjects", "metaobjects"))
    add("metaobjects", "Drizzle ORM", npm_version("metaobjects", "drizzle-orm"))
    add("metaobjects", "zod", npm_version("metaobjects", "zod"))
    return rows


# --------------------------------------------------------------------------- setup


def ensure_installed(setup: str) -> None:
    d = ROOT / setup
    if not (d / "node_modules").exists():
        log(f"{setup}: npm ci")
        r = sh("npm ci --no-audit --no-fund --silent", d)
        if r.returncode != 0:
            raise SystemExit(r.stdout)
    if not (d / ".venv").exists():
        log(f"{setup}: python venv + requirements.txt")
        r = sh("uv venv --python 3.12 .venv -q && uv pip install -q --python .venv/bin/python -r requirements.txt", d)
        if r.returncode != 0:
            raise SystemExit(r.stdout)


def prefetch_images() -> None:
    for image in (PG_IMAGE, ATLAS_IMAGE, OASDIFF_IMAGE):
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode != 0:
            log(f"docker pull {image}")
            subprocess.run(["docker", "pull", "-q", image], check=True, capture_output=True)


def check_shared_probe_files() -> None:
    for rel in ("smoke.sh", "api/smoke.ts", "prompts/welcome/greeting.jinja"):
        if (ROOT / "baseline" / rel).read_bytes() != (ROOT / "metaobjects" / rel).read_bytes():
            raise SystemExit(f"{rel} differs between the two setups; it must be identical")


# --------------------------------------------------------------------------- scorecard


def verdict(o: Outcome) -> str:
    """One word for the log; the scorecard uses layers_cell/compat_cell."""
    if o.scenario.id == "S0":
        return "no false alarm" if o.clean_gate and (o.smoke is None or o.smoke[0]) else "FALSE ALARM"
    return "layers red" if o.layer_failed else ("partner break flagged" if o.compat_failed else "all green")


def probe(o: Outcome) -> str:
    if o.smoke is None:
        return ""
    return "probe passed" if o.smoke[0] else "probe failed"


def layers_cell(o: Outcome) -> str:
    if o.scenario.id == "S0":
        return ("✅ **no false alarm**" if o.clean_gate and (o.smoke is None or o.smoke[0]) else "⚠️ **FALSE ALARM**") \
            + f" · exit {o.gate_rc} · {probe(o)}"
    parts = ["🔴 **red**: " + ", ".join(f"`{n}`" for n in o.layer_failed)] if o.layer_failed else ["🟢 **green**"]
    if o.smoke is not None:
        parts.append(probe(o))
    return " · ".join(parts)


def compat_cell(o: Outcome) -> str:
    if o.scenario.kind == "live":
        return "n/a"
    if not o.has_compat_check:
        return "❌ **no such check**"
    return "✅ **breaking change flagged**" if o.compat_failed else "🟢 none flagged"


def render_scorecard(outcomes: dict[tuple[str, str], Outcome], versions, counts, started: str,
                     scenarios: list[Scenario], seconds: float) -> str:
    md: list[str] = []
    w = md.append
    w("# Head-to-head scorecard")
    w("")
    w("> **Self-measured.** The MetaObjects maintainers wrote both setups and this harness. The baseline is built "
      "to be a competent do-it-yourself stack, but we chose its tools, its scenarios and its app, and a reader "
      "who disagrees with any of those should change them and rerun (`./run.sh`). Read "
      "[README.md](README.md) for what this does and does not measure.")
    w("")
    w(f"Generated by `./run.sh` on {started}; {len(scenarios)} scenarios × 2 setups took {seconds:.0f} s. "
      "Every result cell below is computed from the exit codes of the checks that ran; none is typed by hand.")
    w("")
    w("## Results")
    w("")
    w("Each scenario is one change a developer makes where the setup keeps its source of truth, followed by that "
      "setup's own generators. The pull-request gate (for S5, the live-database check) is then run, and each check's "
      "exit code is recorded. The **probe** is a happy-path run (create a customer through the API, render its prompt "
      "in the worker) that is identical in both setups; it is informational and is not part of either gate. "
      "Two different questions follow, scored separately.")
    w("")
    w("### Do the layers stay consistent?")
    w("")
    w("**red** means at least one check other than the partner-contract diff failed: the model, the generated code, "
      "the database, the prompt and the hand-written code disagreed and a check said so. **green** means every such "
      "check passed. It is not a claim that the change was safe; the probe column says whether the happy path still "
      "works.")
    w("")
    w("| # | Scenario | DIY baseline | MetaObjects |")
    w("|---|---|---|---|")
    for sc in scenarios:
        w(f"| {sc.id} | **{sc.title}** | {layers_cell(outcomes[(sc.id, 'baseline')])} | {layers_cell(outcomes[(sc.id, 'metaobjects')])} |")
    w("")
    w("### Does a breaking change for partners get flagged?")
    w("")
    w("The DIY baseline runs `oasdiff` against the OpenAPI document released to partners. MetaObjects 1.2.0 has no "
      "equivalent check, so it cannot flag a change that is legal everywhere in the project but breaks an outside "
      "caller. This is the row MetaObjects loses.")
    w("")
    w("| # | Scenario | DIY baseline | MetaObjects |")
    w("|---|---|---|---|")
    for sc in scenarios:
        w(f"| {sc.id} | **{sc.title}** | {compat_cell(outcomes[(sc.id, 'baseline')])} | {compat_cell(outcomes[(sc.id, 'metaobjects')])} |")
    w("")
    graded = [s for s in scenarios if s.id != "S0"]
    ids = lambda xs: ", ".join(s.id for s in xs) or "none"  # noqa: E731
    for setup in SETUPS:
        red = [s for s in graded if outcomes[(s.id, setup)].layer_failed]
        w(f"- **{LABEL[setup]}**: layer checks went red on {len(red)} of {len(graded)} scenarios ({ids(red)}).")
    flagged = [s for s in graded if outcomes[(s.id, "baseline")].compat_failed]
    w(f"- **Partner-break check:** the baseline flagged {len(flagged)} ({ids(flagged)}); MetaObjects has none.")
    base_only = [s for s in graded if outcomes[(s.id, "baseline")].layer_failed and not outcomes[(s.id, "metaobjects")].layer_failed]
    mo_only = [s for s in graded if outcomes[(s.id, "metaobjects")].layer_failed and not outcomes[(s.id, "baseline")].layer_failed]
    w(f"- **Where the baseline did better:** the partner-contract check ({ids(flagged)}); layer checks red only on the "
      f"baseline side: {ids(base_only)}.")
    w(f"- **Where MetaObjects did better:** layer checks red only on the MetaObjects side: {ids(mo_only)}.")
    w("")
    w("### What each scenario does")
    w("")
    for sc in scenarios:
        w(f"- **{sc.id} {sc.title}.** {sc.what}")
    w("")
    w("### Which check said so")
    w("")
    for setup in SETUPS:
        w(f"**{LABEL[setup]}**")
        w("")
        names = CHECKS[setup]
        live = ["live-drift"]
        w("| scenario | " + " | ".join(f"`{n}`" for n in names + live) + " |")
        w("|---|" + "---|" * (len(names) + 1))
        for sc in scenarios:
            o = outcomes[(sc.id, setup)]
            row = []
            for n in names + live:
                if n in o.checks:
                    row.append("✓" if o.checks[n][0] else "✗")
                else:
                    row.append("·")
            w(f"| {sc.id} | " + " | ".join(row) + " |")
        w("")
        w("✓ passed, ✗ failed, · not run in that scenario. " + "; ".join(
            f"`{n}`: {CHECK_NOTE[n]}" for n in names) + ". `live-drift`: " + (
            "`atlas schema diff` of the live database against the migrations, wrapped to exit 1 on a non-empty plan"
            if setup == "baseline" else "`meta verify --db` against the live database") + ".")
        w("")
    w("### What the failing checks printed")
    w("")
    w("The informative lines of each failing check's log, picked by a per-check extractor in `harness/run.py` "
      "(paths removed); full logs are written to `.ci-logs/` in the scenario's working directory (`--keep DIR`). "
      "*authoring* is what the setup's own generators said while the developer made the change, before CI.")
    w("")
    for sc in scenarios:
        for setup in SETUPS:
            o = outcomes[(sc.id, setup)]
            items = [f"`{n}`: {ev or '(no output)'}" for n, (ok, ev) in o.checks.items() if not ok]
            if o.smoke is not None and not o.smoke[0]:
                items.append(f"smoke: {o.smoke[1] or '(no output)'}")
            items += [f"authoring: {f}" for f in o.dev_notes]
            if items:
                w(f"- **{sc.id}, {LABEL[setup]}:**")
                for it in items:
                    w(f"  - {it}")
    w("")
    w("## Lines each setup needs")
    w("")
    w("One rule for both: every committed file in the setup's directory counts, minus lock files and "
      "machine-generated output (listed below), minus the smoke probe (identical in both). Blank lines and "
      "comment-only lines do not count. The numbers are from the files in this repository at the commit that "
      "generated this page.")
    w("")
    w("| Category | DIY baseline | MetaObjects |")
    w("|---|---:|---:|")
    cats = [("model", "Model and schema (the sources of truth)"), ("config", "Tool configuration"),
            ("checks", "Checks and glue scripts"), ("app", "Hand-written application code and prompt"),
            ("manifest", "Dependency manifests")]
    for key, label in cats:
        w(f"| {label} | {counts['baseline']['totals'][key]} | {counts['metaobjects']['totals'][key]} |")
    b = sum(counts['baseline']['totals'][k] for k in ("model", "config", "checks"))
    m = sum(counts['metaobjects']['totals'][k] for k in ("model", "config", "checks"))
    w(f"| **Model + configuration + checks** | **{b}** | **{m}** |")
    b = sum(counts['baseline']['totals'].values())
    m = sum(counts['metaobjects']['totals'].values())
    w(f"| **All counted lines** | **{b}** | **{m}** |")
    w("")
    w(f"Not counted, machine-generated: baseline {counts['baseline']['generated_files']} files / "
      f"{counts['baseline']['generated_lines']} lines (`generated/`, `atlas/migrations/`, the released OpenAPI copy); "
      f"MetaObjects {counts['metaobjects']['generated_files']} files / {counts['metaobjects']['generated_lines']} lines "
      "(`api/src/generated/`, `worker/generated/`, `.metaobjects/migrations/`, `.metaobjects/.gen-state/`).")
    w("")
    w("<details><summary>Per-file counts</summary>")
    w("")
    for setup in SETUPS:
        w(f"**{LABEL[setup]}**")
        w("")
        for key, label in cats:
            for rel, n in counts[setup]["files"][key]:
                w(f"- `{rel}` ({key}): {n}")
        w("")
    w("</details>")
    w("")
    w("## Versions")
    w("")
    w("| Scope | Tool | Version |")
    w("|---|---|---|")
    for scope, tool, ver in versions:
        w(f"| {scope} | {tool} | {ver} |")
    w("")
    w(f"Platform: {platform.system()} {platform.machine()}.")
    w("")
    return "\n".join(md)


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scenarios", nargs="*", help="scenario ids to run (default: all), e.g. S1 S3")
    ap.add_argument("--out", default=str(ROOT / "SCORECARD.md"), help="where to write the scorecard")
    ap.add_argument("--json", help="also write raw results to this path")
    ap.add_argument("--keep", help="run in this directory and keep every scenario's working copy and logs")
    args = ap.parse_args()

    for tool in ("docker", "node", "npm", "uv", "git"):
        if shutil.which(tool) is None:
            raise SystemExit(f"missing prerequisite: {tool}")
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        raise SystemExit("docker is installed but its daemon is not reachable")
    wanted = [s for s in SCENARIOS if not args.scenarios or s.id in args.scenarios or s.id == "S0"]

    check_shared_probe_files()
    for setup in SETUPS:
        ensure_installed(setup)
    prefetch_images()
    counts = {s: lines.count_setup(ROOT / s, s) for s in SETUPS}

    t0 = time.time()
    pg = Postgres()
    log(f"Postgres {PG_IMAGE} up as {pg.name} on 127.0.0.1:{pg.port}")
    versions = collect_versions(pg)
    outcomes: dict[tuple[str, str], Outcome] = {}
    keep = Path(args.keep).resolve() if args.keep else None
    if keep:
        keep.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="h2h-") as tmpdir:
        if keep:
            tmpdir = str(keep)
        for sc in wanted:
            for setup in SETUPS:
                log(f"{sc.id} {sc.title} / {setup}")
                o = run_scenario(sc, setup, pg, Path(tmpdir))
                outcomes[(sc.id, setup)] = o
                log(f"  -> {verdict(o)} (gate exit {o.gate_rc}, red: {', '.join(o.layer_failed) or '-'}, partner break: {o.compat_failed}, "
                    f"smoke {'-' if o.smoke is None else ('ok' if o.smoke[0] else 'FAIL')}) {o.seconds:.0f}s")
    card = render_scorecard(outcomes, versions, counts,
                            datetime.now(timezone.utc).strftime("%Y-%m-%d"), wanted, time.time() - t0)
    Path(args.out).write_text(card, encoding="utf-8")
    log(f"wrote {args.out}")
    if args.json:
        Path(args.json).write_text(json.dumps({f"{k[0]}/{k[1]}": {
            "gate_rc": v.gate_rc, "checks": {n: ok for n, (ok, _) in v.checks.items()},
            "smoke": None if v.smoke is None else v.smoke[0], "dev_notes": v.dev_notes}
            for k, v in outcomes.items()}, indent=2), encoding="utf-8")
    control_ok = all(verdict(outcomes[("S0", s)]) == "no false alarm" for s in SETUPS)
    if not control_ok:
        log("the control scenario failed: a setup is red with no change, fix that before reading anything else")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
