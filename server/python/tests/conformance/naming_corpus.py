"""The shared physical-naming corpus's application-registered strategies (ADR-0058
Amendment 1), registered the way a Python application does: through
:func:`metaobjects.naming.register_column_naming_strategy` /
:func:`metaobjects.naming.register_table_naming_rule`, each delegating to the built-in it
names. Idempotent: registering a name again replaces it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from metaobjects.naming import (
    column_naming_strategy,
    register_column_naming_strategy,
    register_table_naming_rule,
    table_naming_rule,
)

CORPUS = Path(__file__).parents[4] / "fixtures" / "naming-conformance" / "physical-names"


def _strategy(inner: Callable[[str], str], upper: set[str], prefix: str) -> Callable[[str], str]:
    return lambda n: n.upper() if n in upper else prefix + inner(n)


def register_corpus_strategies() -> None:
    spec = json.loads((CORPUS / "cases.json").read_text())
    for s in spec["strategies"]:
        upper = set(s.get("upperCase", []))
        prefix = s.get("prefix", "")
        if s["for"] == "columns":
            register_column_naming_strategy(
                s["name"], _strategy(column_naming_strategy(s["delegate"]), upper, prefix)
            )
        else:
            register_table_naming_rule(
                s["name"], _strategy(table_naming_rule(s["delegate"]), upper, prefix)
            )
