#!/usr/bin/env python3
"""Regression test for stages.py --project: a project whose .metaobjects/config.json names a
custom metadata directory must still load and generate.

Oracle: the --project mode's own contract ("runs the same stages on your own project") — the
rust load stage (whose loader resolves "sources" from the config and hard-errors
ERR_SOURCE_UNRESOLVED on a path that does not exist) and the python port's generation stages
(prepared through install_config) report status "ok". Before the sources rewrite in main(),
the config's "sources" entry pointed at the custom directory, which does not exist in the
scratch copy (the metadata itself is always copied to metaobjects/), so the rust load stage
reported "failed". The python load stage alone cannot catch this: its driver loads the copied
directory directly. Run by hand, like the rest of scripts/bench-load/ (no test lane reads this
directory; see scripts/ci-lane-map.txt). Needs cargo.

usage: python3 scripts/bench-load/test-stages-project.py
"""
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
        stages = report["results"]["python"]
        self.assertEqual(stages["load"]["status"], "ok")
        for stage in ("gen-noop", "gen-full", "gen-edit"):
            self.assertEqual(stages[stage]["status"], "ok", stages[stage])


if __name__ == "__main__":
    unittest.main()
