#!/usr/bin/env python3
"""Cross-port stage benchmark: every MetaObjects port, the same model, stage by stage.

usage: stages.py [--runs 5] [--ports "typescript python csharp java kotlin rust"]
                 [--copies 20] [--out <dir>]
                 [--project <path-to-a-project> [--metadata-dir metaobjects]]

Stages (each is the median of --runs runs, with the peak resident set of the process):

  load       warm load and validate of the model (one untimed warm-up load first)
  gen-noop   the generation command run again with nothing changed
  gen-full   the generation command from clean output and clean generation state
  gen-edit   the generation command after one entity gains one field

It writes report.json (machine-readable) and report.md (one table) into --out, and never
fails on a number: a delta between two machines measures the machine, so there is no
threshold. A stage a port cannot run is reported as "not available" with the reason (the
Rust generation stages read that way until `cargo meta gen` exists, and are picked up
automatically once it does).

Default model: the public persistence-conformance fitness model repeated --copies times, with
every declaration renamed per copy so the copies can be generated as well as loaded
(`gen-model.py --unique-names`). It is the same model `run.sh`, `load_bench` and the
reference-lookup profiling use.

--project runs the same stages on your own project instead. Its metadata directory and, when
present, its .metaobjects/config.json are COPIED into a scratch directory (the project is never
written to) and the report is written to --out, which must be OUTSIDE this repository. Only the
model label is anonymized (counts); failure reasons may quote commands and errors, so a private
run stays local and its report is never committed. The TypeScript and Java load drivers and the
Java/Kotlin generation projects pass no libraries option, so a project using libraries still
fails those columns.

Generation runs each port's own command with ONE reference generator chosen to exist and work
in that port (typescript: entity + names; python: entity; csharp: entity; java: dto +
value-object; kotlin: entity; rust: whatever `cargo meta gen` is configured with), so a
generation row compares a port with its earlier self and with the other ports' trend, not the
same bytes. Scratch lives under $DEV_SCRATCH (else the system temp dir) and is removed on exit.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ALL_PORTS = ["typescript", "python", "csharp", "java", "kotlin", "rust"]
STAGES = ["load", "gen-noop", "gen-full", "gen-edit"]


class NotAvailable(Exception):
    """A stage this port cannot run here, with the reason to print."""


# --------------------------------------------------------------------------- processes


def run(cmd, cwd, env=None, check=True):
    """Run one command; return (wall seconds, peak RSS KiB of it and its descendants, stdout)."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        t0 = time.perf_counter()
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=out, stderr=err)
        _, status, usage = os.wait4(p.pid, 0)
        wall = time.perf_counter() - t0
        code = os.waitstatus_to_exitcode(status)
        out.seek(0)
        err.seek(0)
        stdout = out.read().decode(errors="replace")
        stderr = err.read().decode(errors="replace")
    if check and code != 0:
        tail = (stderr or stdout).strip().splitlines()[-3:]
        raise RuntimeError(f"`{' '.join(map(str, cmd[:3]))} ...` exited {code}: {' | '.join(tail)[:300]}")
    return wall, usage.ru_maxrss, stdout


def have(tool):
    return shutil.which(tool) is not None


def version(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return ((out.stdout or out.stderr).strip().splitlines() or [""])[0]
    except Exception:  # noqa: BLE001 - a missing tool is reported as unknown
        return "unknown"


# --------------------------------------------------------------------------- the model


def copy_model(src: Path, dest: Path) -> None:
    """Copy a metadata directory without its dotfiles or build output."""
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".*", "node_modules", "target", "bin", "obj"))


def install_config(project: Path, model: Path) -> None:
    """Write a port scratch project's .metaobjects/config.json: the source project's own config
    when the benchmark copied one next to the model, else the minimal synthetic config."""
    src = model.parent / ".metaobjects" / "config.json"
    (project / ".metaobjects").mkdir(exist_ok=True)
    if src.exists():
        shutil.copy(src, project / ".metaobjects" / "config.json")
    else:
        (project / ".metaobjects" / "config.json").write_text('{"schema_version": 1}\n')


def model_files(model: Path):
    return sorted(p for p in model.rglob("*") if p.is_file() and p.suffix in (".json", ".yaml", ".yml"))


def apply_edit(model: Path, n: int) -> None:
    """Add one field to the first entity of the first JSON file (a different name each time,
    so every edit is a real change to the model)."""
    for path in model_files(model):
        if path.suffix != ".json":
            continue
        doc = json.loads(path.read_text())
        children = doc.get("metadata.root", {}).get("children", [])
        for child in children:
            for key, body in child.items():
                if key.startswith("object.entity") and isinstance(body, dict):
                    body.setdefault("children", []).append({"field.string": {"name": f"benchEdit{n}"}})
                    path.write_text(json.dumps(doc, indent=2) + "\n")
                    return
    raise NotAvailable("no JSON file with an object.entity to edit (the edit stage edits JSON only)")


# --------------------------------------------------------------------------- ports


class Port:
    name = ""
    clean_dirs: list[str] = []

    def __init__(self, ctx):
        self.ctx = ctx
        self.project: Path | None = None
        self.gen_error: str | None = None

    # -- load
    def load(self, model: Path, runs: int):
        raise NotAvailable("no load driver")

    # -- generation
    def prepare(self, work: Path, model: Path) -> None:
        raise NotAvailable("no generation project")

    def gen_command(self) -> list[str]:
        raise NotAvailable("no generation command")

    def gen_env(self):
        return None

    def clean(self):
        for d in self.clean_dirs + [".metaobjects/.gen-state"]:
            shutil.rmtree(self.project / d, ignore_errors=True)

    def gen(self):
        return run(self.gen_command(), self.project, self.gen_env())


def drive(cmd, env=None):
    """Run a warm-load driver and parse its last JSON line."""
    out = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip().splitlines()[-1][:300])
    last = [ln for ln in out.stdout.splitlines() if ln.startswith("{")][-1]
    d = json.loads(last)
    return d["median_ms"], d["peak_rss_mib"]


class TypeScript(Port):
    name = "typescript"
    clean_dirs = ["src/generated"]

    def _meta(self):
        return ["bun", str(REPO / "server/typescript/packages/cli/bin/meta.ts")]

    def load(self, model, runs):
        dist = REPO / "server/typescript/packages/metadata/dist"
        if not (dist / "index.js").exists():
            raise NotAvailable("the metadata package is not built (bun run --filter '*' build)")
        return drive(["node", str(HERE / "ts-load.mjs"), str(model), str(runs)], {**os.environ, "MO_TS_DIST": str(dist)})

    def prepare(self, work, model):
        if not have("bun"):
            raise NotAvailable("bun is not installed")
        self.project = work / "ts"
        self.project.mkdir()
        run(self._meta() + ["init", "--no-skills", "--quiet"], self.project)
        shutil.rmtree(self.project / "metaobjects", ignore_errors=True)
        copy_model(model, self.project / "metaobjects")
        cfg = self.project / "metaobjects.config.ts"
        text = cfg.read_text()
        text = text.replace(
            'import { defineConfig } from "@metaobjectsdev/cli";',
            'import { defineConfig } from "@metaobjectsdev/cli";\n'
            'import { entityFile, namesFile } from "@metaobjectsdev/codegen-ts/generators";',
        )
        cfg.write_text(text.replace("generators: [],", "generators: [entityFile(), namesFile()],"))

    def gen_command(self):
        return self._meta() + ["gen"]


class Python(Port):
    name = "python"
    clean_dirs = ["src/generated"]

    def load(self, model, runs):
        return drive(["python3", "-I", str(HERE / "py_load.py"), str(model), str(runs)],
                     {**os.environ, "MO_PY_SRC": str(REPO / "server/python/src")})

    def prepare(self, work, model):
        self.project = work / "py"
        self.project.mkdir()
        copy_model(model, self.project / "metaobjects")
        install_config(self.project, model)
        (self.project / "metaobjects.config.yaml").write_text(
            "metadata: metaobjects\ntargets:\n  api:\n    outDir: src/generated\n    generators: [entity]\n")

    def gen_command(self):
        src = str(REPO / "server/python/src")
        return ["python3", "-I", "-c",
                f"import sys; sys.path.insert(0, {src!r}); from metaobjects.cli import main; sys.argv = ['metaobjects', 'gen']; sys.exit(main())"]


class CSharp(Port):
    name = "csharp"
    clean_dirs = ["out"]

    def _cli(self):
        dll = self.ctx.work / "cs-cli/MetaObjects.Cli.dll"
        if not dll.exists():
            if not have("dotnet"):
                raise NotAvailable("dotnet is not installed")
            run(["dotnet", "build", str(REPO / "server/csharp/MetaObjects.Cli/MetaObjects.Cli.csproj"),
                 "-c", "Release", "-o", str(self.ctx.work / "cs-cli"), "-v", "quiet", "-nologo"], REPO)
        return dll

    def load(self, model, runs):
        if not have("dotnet"):
            raise NotAvailable("dotnet is not installed")
        drv = self.ctx.work / "cs-load"
        if not (drv / "LoadBench.dll").exists():
            drv.mkdir()
            shutil.copy(HERE / "csharp/LoadBench.csproj", drv)
            shutil.copy(HERE / "csharp/Program.cs", drv)
            run(["dotnet", "build", "LoadBench.csproj", "-c", "Release", "-o", str(drv / "out"),
                 f"-p:MetaObjectsProject={REPO / 'server/csharp/MetaObjects/MetaObjects.csproj'}",
                 "-v", "quiet", "-nologo"], drv)
        return drive(["dotnet", str(drv / "out/LoadBench.dll"), str(model), str(runs)])

    def prepare(self, work, model):
        cli = self._cli()
        self.project = work / "cs"
        self.project.mkdir()
        run(["dotnet", str(cli), "init", "--root", str(self.project)], self.project)
        copy_model(model, self.project / "metaobjects")
        proj = self.project / "codegen/Codegen.csproj"
        proj.write_text(re.sub(
            r'<PackageReference Include="MetaObjects.Codegen"[^>]*/>',
            f'<ProjectReference Include="{REPO / "server/csharp/MetaObjects.Codegen/MetaObjects.Codegen.csproj"}" />',
            proj.read_text()))
        gens = self.project / "codegen/Generators.cs"
        gens.write_text(gens.read_text().replace(
            "    [\n", "    [\n        new MetaObjects.Codegen.Generators.EntityGenerator(),\n", 1))
        cfg = self.project / ".metaobjects/config.json"
        src_cfg = model.parent / ".metaobjects" / "config.json"
        if src_cfg.exists():
            shutil.copy(src_cfg, cfg)
        c = json.loads(cfg.read_text())
        c["csharp"] = {"outDir": "out", "namespace": "Bench"}
        cfg.write_text(json.dumps(c, indent=2))
        self._dll = cli

    def gen_command(self):
        return ["dotnet", str(self._dll), "gen"]


class Java(Port):
    name = "java"
    clean_dirs = ["target"]
    artifact = "metaobjects-codegen-spring"
    generators = [("com.metaobjects.generator.spring.SpringDtoGenerator", "java"),
                  ("com.metaobjects.generator.spring.SpringValueObjectGenerator", "java")]

    def _version(self):
        m = re.search(r"<version>([^<]+)</version>", (REPO / "server/java/pom.xml").read_text())
        return m.group(1)

    def load(self, model, runs):
        if not have("mvn") or not have("java"):
            raise NotAvailable("mvn and java are not installed")
        v = self._version()
        jl = self.ctx.work / "java-load"
        if not (jl / "cp.txt").exists():
            jl.mkdir()
            (jl / "pom.xml").write_text(
                '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>'
                '<groupId>bench</groupId><artifactId>load</artifactId><version>1</version><dependencies><dependency>'
                f'<groupId>com.metaobjects</groupId><artifactId>metaobjects-metadata</artifactId><version>{v}</version>'
                '</dependency></dependencies></project>')
            try:
                run(["mvn", "-o", "-q", "-B", "dependency:build-classpath", f"-Dmdep.outputFile={jl / 'cp.txt'}"], jl)
            except RuntimeError as e:
                raise NotAvailable(f"metaobjects-metadata {v} is not in the local Maven repository (mvn install): {e}")
        cp = (jl / "cp.txt").read_text().strip()
        return drive(["java", "-cp", cp, str(HERE / "java/JavaLoad.java"), str(model), str(runs)])

    def prepare(self, work, model):
        if not have("mvn"):
            raise NotAvailable("mvn is not installed")
        v = self._version()
        self.project = work / self.name
        self.project.mkdir()
        copy_model(model, self.project / "src/main/metaobjects")
        gens = "".join(
            f"<generator><classname>{c}</classname><args><outputDir>${{project.build.directory}}/generated-sources/{d}"
            f"</outputDir></args></generator>" for c, d in self.generators)
        (self.project / "pom.xml").write_text(
            '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>'
            '<groupId>bench</groupId><artifactId>bench</artifactId><version>1</version><packaging>pom</packaging>'
            '<build><plugins><plugin><groupId>com.metaobjects</groupId><artifactId>metaobjects-maven-plugin</artifactId>'
            f'<version>{v}</version><dependencies><dependency><groupId>com.metaobjects</groupId>'
            f'<artifactId>{self.artifact}</artifactId><version>{v}</version></dependency></dependencies>'
            f'<configuration><loader><sourceDir>src/main/metaobjects</sourceDir></loader><generators>{gens}</generators>'
            '</configuration></plugin></plugins></build></project>')

    def gen_command(self):
        return ["mvn", "-o", "-q", "-B", "metaobjects:generate"]


class Kotlin(Java):
    name = "kotlin"
    artifact = "metaobjects-codegen-kotlin"
    generators = [("com.metaobjects.generator.kotlin.KotlinEntityGenerator", "kotlin")]

    def load(self, model, runs):
        raise NotAvailable("loads through the Java loader (metadata-ktx is a facade); see the java column")


class Rust(Port):
    name = "rust"
    clean_dirs = ["generated"]

    def _target(self):
        return Path(os.environ.get("DEV_SCRATCH") or tempfile.gettempdir()) / "mo-bench-rust-target"

    def load(self, model, runs):
        if not have("cargo"):
            raise NotAvailable("cargo is not installed")
        env = {**os.environ, "CARGO_TARGET_DIR": str(self._target())}
        run(["cargo", "build", "--release", "--example", "load_bench"], REPO / "server/rust", env)
        exe = self._target() / "release/examples/load_bench"
        meta = model.parent
        if not (meta / ".metaobjects/config.json").exists():
            (meta / ".metaobjects").mkdir(exist_ok=True)
            (meta / ".metaobjects/config.json").write_text('{"schema_version": 1}\n')
        return drive([str(exe), "--dir", str(meta), "--json", "--iterations", str(runs)])

    def _meta_command(self):
        """The `cargo meta` command, if one exists: an installed `cargo-meta`, a built one in
        the workspace target directory, or MO_BENCH_RUST_META (a command line)."""
        override = os.environ.get("MO_BENCH_RUST_META")
        if override:
            return override.split()
        if have("cargo-meta"):
            return ["cargo", "meta"]
        for rel in ("target/release/cargo-meta", "target/debug/cargo-meta"):
            exe = REPO / "server/rust" / rel
            if exe.exists():
                return [str(exe)]
        return None

    def prepare(self, work, model):
        if self._meta_command() is None:
            raise NotAvailable("not available yet: `cargo meta gen` does not exist")
        self.project = work / "rs"
        self.project.mkdir()
        copy_model(model, self.project / "metaobjects")
        install_config(self.project, model)

    def gen_command(self):
        extra = os.environ.get("MO_BENCH_RUST_GEN_ARGS", "").split()
        return self._meta_command() + ["gen"] + extra


PORT_CLASSES = {c.name: c for c in (TypeScript, Python, CSharp, Java, Kotlin, Rust)}


# --------------------------------------------------------------------------- stages


class Ctx:
    def __init__(self, work: Path):
        self.work = work


def cell(median_ms, rss_kib):
    return {"status": "ok", "median_ms": round(median_ms, 1), "peak_rss_mib": round(rss_kib / 1024) if rss_kib else None}


def measure(fn, runs):
    times, rss = [], []
    for _ in range(runs):
        wall, kib, _ = fn()
        times.append(wall * 1000)
        rss.append(kib)
    return cell(statistics.median(times), max(rss))


def bench_port(port: Port, work: Path, model: Path, runs: int, log):
    result = {}
    # load
    try:
        ms, mib = port.load(model, runs)
        result["load"] = {"status": "ok", "median_ms": ms, "peak_rss_mib": mib}
    except NotAvailable as e:
        result["load"] = {"status": "not available", "reason": str(e)}
    except Exception as e:  # noqa: BLE001
        result["load"] = {"status": "failed", "reason": str(e)[:300]}
    log(f"  {port.name} load: {result['load']}")
    # generation
    try:
        port.prepare(work, model)
        port.clean()
        port.gen()  # untimed priming run: builds the generation project, warms caches
        stages = {}
        stages["gen-noop"] = measure(port.gen, runs)
        log(f"  {port.name} gen-noop: {stages['gen-noop']}")

        def full():
            port.clean()
            return port.gen()

        stages["gen-full"] = measure(full, runs)
        log(f"  {port.name} gen-full: {stages['gen-full']}")
        counter = iter(range(1, 10_000))

        def edit():
            apply_edit(port.project / port.model_dir(), next(counter))
            return port.gen()

        try:
            stages["gen-edit"] = measure(edit, runs)
        except NotAvailable as e:
            stages["gen-edit"] = {"status": "not available", "reason": str(e)}
        log(f"  {port.name} gen-edit: {stages['gen-edit']}")
        result.update(stages)
    except NotAvailable as e:
        for s in STAGES[1:]:
            result[s] = {"status": "not available", "reason": str(e)}
        log(f"  {port.name} generation: {e}")
    except Exception as e:  # noqa: BLE001
        for s in STAGES[1:]:
            result[s] = {"status": "failed", "reason": str(e)[:300]}
        log(f"  {port.name} generation failed: {e}")
    return result


def model_dir(self):
    return "src/main/metaobjects" if isinstance(self, Java) else "metaobjects"


Port.model_dir = model_dir


def render_md(report) -> str:
    ports = report["ports"]
    lines = [f"# Cross-port stage benchmark", "",
             f"Model: {report['model']['label']}. Each cell is the median of {report['runs']} runs in ms, "
             "then the peak resident set in MiB. Record only: no threshold, and a delta between two "
             "machines measures the machine.", ""]
    lines.append("| stage | " + " | ".join(ports) + " |")
    lines.append("|---|" + "---|" * len(ports))
    for stage in STAGES:
        row = []
        for p in ports:
            c = report["results"][p][stage]
            if c["status"] == "ok":
                rss = f" / {c['peak_rss_mib']} MiB" if c.get("peak_rss_mib") else ""
                row.append(f"{c['median_ms']} ms{rss}")
            elif c["status"] == "not available":
                row.append("not available")
            else:
                row.append("failed")
        lines.append(f"| {stage} | " + " | ".join(row) + " |")
    notes = [(p, s, c["reason"]) for p in ports for s in STAGES
             for c in [report["results"][p][s]] if c["status"] != "ok"]
    if notes:
        lines += ["", "Notes:", ""]
        seen = set()
        for p, s, reason in notes:
            if (p, reason) not in seen:
                seen.add((p, reason))
                lines.append(f"- {p} ({s}): {reason}")
    e = report["environment"]
    lines += ["", f"Machine: {e['os']}, {e['cpus']} CPUs. Tools: " + ", ".join(f"{k} {v}" for k, v in e["tools"].items()) + "."]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--ports", default=" ".join(ALL_PORTS))
    ap.add_argument("--copies", type=int, default=20)
    ap.add_argument("--out", help="where report.json and report.md are written")
    ap.add_argument("--project", help="a project to measure instead of the public fixture (stays local)")
    ap.add_argument("--metadata-dir", default="metaobjects", help="the project's metadata directory (default metaobjects)")
    args = ap.parse_args()

    ports = args.ports.split()
    for p in ports:
        if p not in PORT_CLASSES:
            ap.error(f"unknown port {p!r}; choose from {' '.join(ALL_PORTS)}")

    scratch = Path(os.environ.get("DEV_SCRATCH") or tempfile.gettempdir())
    out = Path(args.out).resolve() if args.out else scratch / "bench-ports-report"
    if args.project:
        if not args.out:
            ap.error("--project needs --out, outside this repository")
        if out == REPO or REPO in out.parents:
            ap.error("--out must be outside this repository: a private project's report is never committed")
    work = Path(tempfile.mkdtemp(prefix="bench-stages.", dir=scratch))
    try:
        # The model, once, in a directory every port copies from.
        if args.project:
            src = Path(args.project).resolve() / args.metadata_dir
            if not src.is_dir():
                ap.error(f"no metadata directory at <project>/{args.metadata_dir}")
            model = work / "model/metaobjects"
            copy_model(src, model)
            src_cfg = src.parent / ".metaobjects" / "config.json"
            if src_cfg.exists():
                cfg = json.loads(src_cfg.read_text())
                cfg["sources"] = [{"path": "metaobjects"}]
                (model.parent / ".metaobjects").mkdir()
                (model.parent / ".metaobjects" / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
            files = model_files(model)
            label = f"a private project ({len(files)} metadata files, {sum(f.stat().st_size for f in files) // 1024} KiB)"
        else:
            model = work / "model/metaobjects"
            subprocess.run([sys.executable, str(HERE / "gen-model.py"), str(args.copies), str(model), "--unique-names"], check=True)
            label = f"{args.copies} copies of the fitness model (public fixture, per-copy names)"
        print(f"model: {label}", file=sys.stderr)

        ctx = Ctx(work)
        results = {}
        for name in ports:
            print(f"{name}:", file=sys.stderr)
            results[name] = bench_port(PORT_CLASSES[name](ctx), work, model, args.runs, lambda m: print(m, file=sys.stderr))

        commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
        report = {
            "model": {"label": label, "private": bool(args.project)},
            "runs": args.runs,
            "ports": ports,
            "stages": STAGES,
            "results": results,
            "environment": {
                "os": f"{platform.system()} {platform.release()}",
                "cpus": os.cpu_count(),
                "commit": commit,
                "tools": {"node": version(["node", "--version"]), "bun": version(["bun", "--version"]),
                          "python": platform.python_version(), "dotnet": version(["dotnet", "--version"]),
                          "java": version(["java", "-version"]), "rustc": version(["rustc", "--version"])},
            },
        }
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        (out / "report.md").write_text(render_md(report))
        print((out / "report.md").read_text())
        print(f"report: {out}/report.json and report.md", file=sys.stderr)
        return 1 if any(c["status"] == "failed" for r in results.values() for c in r.values()) else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
