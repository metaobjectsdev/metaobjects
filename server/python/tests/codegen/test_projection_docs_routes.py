"""The api-contract ``projection/`` corpus, docs half.

The REST routes a read-only projection's api page lists are exactly the routes its generated
surface answers with a row. Every port runs this assertion over the same model and the same
expected set (``fixtures/api-contract-conformance/projection/docs-routes.json``):

* a projection with a declared identity lists ``GET <path>`` and ``GET <path>/{id}``;
* one with none lists ``GET <path>`` alone, even when it has a field named ``id``;
* no unit lists a write verb.

The booted-server half of the same contract is the corpus scenarios themselves
(``tests/integration/test_api_contract_projection.py``).
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.apidocs import ApiSymbolKind, PythonApiModelBuilder


def _corpus() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "fixtures" / "api-contract-conformance" / "projection"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/api-contract-conformance/projection")


def _normalize(symbol: str) -> str:
    """The spelling every port's expected set uses: no leading ``/`` or ``/api`` prefix,
    ``{id}`` for the item parameter (this port names it after the object)."""
    verb, path = symbol.split(" ", 1)
    path = re.sub(r"^/?(?:api/)?", "", path)
    path = re.sub(r"\{[a-z_]+_id\}", "{id}", path)
    return f"{verb} {path}"


def test_each_projection_documents_exactly_the_routes_it_mounts(tmp_path: Path) -> None:
    corpus = _corpus()
    expected = json.loads((corpus / "docs-routes.json").read_text())["units"]
    # The loader reads a directory: give it meta.json alone, not the sibling seed and scenarios.
    shutil.copy(corpus / "meta.json", tmp_path / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp_path))
    assert not result.errors, result.errors
    model = PythonApiModelBuilder().build(result.root, "projection-docs")
    for node, routes in expected.items():
        unit = next(u for u in model.units if u.node == node)
        documented = sorted(
            _normalize(s.name) for s in unit.symbols if s.kind == ApiSymbolKind.REST
        )
        assert documented == sorted(routes), node
