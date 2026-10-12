"""The shared eject contract, as this port reads it (ADR-0034 Amendment 8).

``fixtures/generator-registry-conformance/registry.json`` says, for every generator, whether
an owned copy holds its emit (``"eject": "full"``) or why it is exempt, and in its top-level
``eject`` block what an owned copy may still import (the engine surface) and every place the
contract does not hold yet (``pending``). The tests in ``test_eject_contract.py`` assert the
contract; this module only reads the file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

PORT = "python"

ASSERTIONS = ("census", "completeness", "depth")


def manifest_path() -> Path:
    """Walk up to the repo root (the directory holding both ``fixtures/`` and ``server/``)."""
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "generator-registry-conformance" / "registry.json"
        if (p / "server").is_dir() and candidate.is_file():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/generator-registry-conformance/registry.json not found")


def manifest() -> dict[str, Any]:
    return json.loads(manifest_path().read_text(encoding="utf-8"))


def port_slice() -> dict[str, dict[str, Any]]:
    """The generators the manifest expects this port to expose."""
    return {n: s for n, s in manifest()["generators"].items() if PORT in s.get("ports", [])}


def is_exempt(name: str) -> bool:
    return isinstance(manifest()["generators"][name]["eject"], dict)


def pending(assertion: str) -> dict[str, list[dict[str, Any]]]:
    """This port's pending entries for one assertion, by generator. A generator has one
    entry per gap: a depth entry's ``outside`` lists the imports that gap closes."""
    assert assertion in ASSERTIONS, assertion
    out: dict[str, list[dict[str, Any]]] = {}
    for p in manifest()["eject"]["pending"]:
        if p["port"] == PORT and p["assertion"] == assertion:
            out.setdefault(p["generator"], []).append(p)
    return out


def _glob(pattern: str) -> re.Pattern[str]:
    """``**`` matches any run of characters, ``*`` one dotted segment."""
    out = ""
    for part in re.split(r"(\*\*|\*)", pattern):
        out += ".*" if part == "**" else "[^.]*" if part == "*" else re.escape(part)
    return re.compile(out + r"\Z")


class EngineSurface:
    """What an owned copy may import from the port's codegen packages."""

    def __init__(self) -> None:
        spec = manifest()["eject"]["engineSurface"][PORT]
        self._scope = [_glob(p) for p in spec["codegenPackages"]]
        self._engine = [_glob(p) for p in spec["engine"]]
        self.engine = list(spec["engine"])

    def in_codegen_packages(self, module: str) -> bool:
        return any(p.match(module) for p in self._scope)

    def outside(self, module: str) -> bool:
        """True when *module* writes output: inside the codegen packages, not engine."""
        return self.in_codegen_packages(module) and not any(p.match(module) for p in self._engine)
