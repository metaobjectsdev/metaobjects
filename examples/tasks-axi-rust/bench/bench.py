#!/usr/bin/env python3
"""Interleaved start-up and memory benchmark: the real tasks-axi (node) vs tasks-axi-rs.

    python3 bench/bench.py [--runs 30] [--tasks 200] [--rust PATH] [--node tasks-axi]

For each scenario it builds a synthetic backlog, does one untimed warm-up run of each tool, then
alternates node / rust for --runs timed runs (interleaving, so a load spike hits both). It reports
median and p95 wall time, median CPU time (user+sys, which is steadier than wall time on a busy
machine) and median peak resident memory. It also checks every scenario's output is identical
between the two tools before timing it.

Needs `tasks-axi` on PATH and a built tasks-axi-rs (cargo build --release -p tasks-axi-rs).
"""

import argparse
import os
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def backlog(n: int) -> str:
    """A deterministic synthetic backlog of about n tasks across the three live states."""
    out = ["# Backlog", ""]
    for state, share in (("In flight", 0.2), ("Queued", 0.5), ("Done", 0.3)):
        out += [f"## {state}", ""]
        for i in range(int(n * share)):
            tid = f"{state[:2].lower()}-{i:04d}"
            dep = f" blocked-by: qu-{i:04d}" if state == "In flight" and i % 3 == 0 else ""
            kind = ("task", "scout", "bug")[i % 3]
            out.append(f"- [{'x' if state == 'Done' else ' '}] {tid} - Synthetic {kind} number {i} (repo: repo-{i % 5}, kind: {kind}){dep}")
            out.append("  A body line for this task that is long enough to be worth truncating " * 3)
        out.append("")
    return "\n".join(out) + "\n"


def timed(cmd, cwd, env):
    """One run: (wall seconds, cpu seconds, peak RSS in KiB, stdout)."""
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True)
    wall = time.perf_counter() - t0
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)
    return wall, cpu, after.ru_maxrss, p.stdout


def peak_rss_kib(cmd, cwd, env):
    """Peak RSS of one run, measured in a fresh child so ru_maxrss is not a running maximum."""
    code = (
        "import resource,subprocess,sys;"
        "subprocess.run(sys.argv[1:],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
        "print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)"
    )
    p = subprocess.run([sys.executable, "-c", code, *cmd], cwd=cwd, env=env, capture_output=True, text=True)
    return int(p.stdout.strip())


def p95(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--tasks", type=int, default=200)
    ap.add_argument("--node", default="tasks-axi")
    default_target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(HERE, "..", "target")
    ap.add_argument("--rust", default=os.path.join(default_target, "release", "tasks-axi-rs"))
    args = ap.parse_args()
    if not os.path.exists(args.rust):
        print(f"{args.rust} not found: cargo build --release -p tasks-axi-rs", file=sys.stderr)
        return 2
    if shutil.which(args.node) is None:
        print(f"{args.node} not on PATH", file=sys.stderr)
        return 2

    base = os.environ.get("DEV_SCRATCH") or tempfile.gettempdir()
    work = tempfile.mkdtemp(prefix="tasks-axi-bench-", dir=base)
    try:
        home = os.path.join(work, "home")
        os.makedirs(home)
        for n, label in ((args.tasks, f"{args.tasks} tasks"), (5, "5 tasks")):
            cwd = os.path.join(work, f"cwd-{n}")
            os.makedirs(cwd)
            with open(os.path.join(cwd, "backlog.md"), "w", encoding="utf-8") as f:
                f.write(backlog(n))
            env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "TZ": "UTC"}
            scenarios = [("list", ["list"]), ("ready", ["ready"]), ("show", ["show", "qu-0001"])]
            print(f"\n{label} (--runs {args.runs})")
            print(f"{'command':8} {'tool':6} {'median ms':>10} {'p95 ms':>8} {'cpu ms':>8} {'peak RSS MiB':>13}")
            for name, argv in scenarios:
                tools = {"node": [args.node, *argv], "rust": [args.rust, *argv]}
                outs = {k: timed(c, cwd, env)[3] for k, c in tools.items()}
                if outs["node"] != outs["rust"]:
                    print(f"{name}: OUTPUT DIFFERS between node and rust; not timing it", file=sys.stderr)
                    return 1
                samples = {k: [] for k in tools}
                for _ in range(args.runs):
                    for k, c in tools.items():  # interleaved
                        wall, cpu, _, _ = timed(c, cwd, env)
                        samples[k].append((wall, cpu))
                for k, c in tools.items():
                    walls = [w * 1000 for w, _ in samples[k]]
                    cpus = [c_ * 1000 for _, c_ in samples[k]]
                    rss = statistics.median(peak_rss_kib(c, cwd, env) for _ in range(5)) / 1024
                    print(f"{name:8} {k:6} {statistics.median(walls):10.1f} {p95(walls):8.1f} {statistics.median(cpus):8.1f} {rss:13.1f}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
