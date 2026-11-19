#!/usr/bin/env python3
"""Regression tests for stages.py --project: a project whose .metaobjects/config.json names a
custom metadata directory must still load and generate, and every port's scratch project must
receive the benchmark's copied (rewritten) config.

Oracle: the --project mode's own contract ("runs the same stages on your own project") — the
rust load stage (whose loader resolves "sources" from the config and hard-errors
ERR_SOURCE_UNRESOLVED on a path that does not exist) and the python port's generation stages
(prepared through install_config) report status "ok". Before the sources rewrite in main(),
the config's "sources" entry pointed at the custom directory, which does not exist in the
scratch copy (the metadata itself is always copied to metaobjects/), so the rust load stage
reported "failed". The python load stage alone cannot catch this: its driver loads the copied
directory directly. The prepare test iterates every registered port so a future port cannot
skip the shared install_config step. Run by hand, like the rest of scripts/bench-load/ (no test
lane reads this directory; see scripts/ci-lane-map.txt). Needs cargo, bun, dotnet and mvn for
the ports it exercises; a port whose toolchain or generator is missing is skipped.

usage: python3 scripts/bench-load/test-stages-project.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIXTURE = REPO / "fixtures/conformance/attr-default-polymorphic/input"
CUSTOM_DIR = "model-src"

_spec = importlib.util.spec_from_file_location("stages", HERE / "stages.py")
stages = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stages)

REWRITTEN = {"schema_version": 1, "sources": [{"path": "metaobjects"}],
             "naming": {"columns": "literal", "tables": "literal"}}


class ProjectModeTest(unittest.TestCase):
    def run_stages(self, project: Path, out: Path):
        return subprocess.run(
            [sys.executable, str(HERE / "stages.py"), "--project", str(project),
             "--metadata-dir", CUSTOM_DIR, "--ports", "rust python", "--runs", "1", "--out", str(out)],
            capture_output=True, text=True, timeout=1200)

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="bench-stages-test.", dir=os.environ.get("DEV_SCRATCH") or None))
        self.project = self.scratch / "proj"
        (self.project / CUSTOM_DIR).mkdir(parents=True)
        (self.project / ".metaobjects").mkdir()
        shutil.copytree(FIXTURE, self.project / CUSTOM_DIR, dirs_exist_ok=True)
        (self.project / ".metaobjects/config.json").write_text(
            json.dumps({"schema_version": 1, "sources": [{"path": CUSTOM_DIR}]}) + "\n")

    def tearDown(self):
        shutil.rmtree(self.scratch, ignore_errors=True)

    def test_custom_metadata_dir_loads_and_generates(self):
        out = self.scratch / "out"
        r = self.run_stages(self.project, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads((out / "report.json").read_text())
        self.assertEqual(report["results"]["rust"]["load"]["status"], "ok",
                         report["results"]["rust"]["load"])
        py = report["results"]["python"]
        self.assertEqual(py["load"]["status"], "ok")
        for stage in ("gen-noop", "gen-full", "gen-edit"):
            self.assertEqual(py[stage]["status"], "ok", py[stage])

    def test_every_port_prepare_installs_copied_config(self):
        work = self.scratch / "prep"
        model = work / "model/metaobjects"
        shutil.copytree(FIXTURE, model)
        (work / "model/.metaobjects").mkdir(parents=True)
        (work / "model/.metaobjects/config.json").write_text(json.dumps(REWRITTEN) + "\n")
        ctx = stages.Ctx(work)
        checked = []
        for name, cls in stages.PORT_CLASSES.items():
            port = cls(ctx)
            try:
                port.prepare(work, model)
            except stages.NotAvailable:
                continue
            installed = json.loads((port.project / ".metaobjects/config.json").read_text())
            self.assertTrue(all(installed.get(k) == v for k, v in REWRITTEN.items()),
                            f"{name}: {installed}")
            checked.append(name)
        self.assertIn("python", checked)
        self.assertIn("typescript", checked)


if __name__ == "__main__":
    unittest.main()
