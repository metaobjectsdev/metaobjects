"""The SQL engine a persistence scenario runs on.

Postgres is the corpus' own engine: the scenario YAML holds its seed SQL and its wire-form
``expect``. SQLite and MySQL run the same scenarios against their own TypeScript-produced
schema artifact (``canonical/schema.<engine>.sql``), with the seed re-spelled for the engine
where its spelling differs. The ``expect`` blocks are NEVER loosened: the runtime hands back
native Python types decoded from the field's declared type, and the same serialization
boundary (``normalization.py``) maps them onto the wire form on the actual side only.

Mirrors the Kotlin ``ScenarioEngine`` and the C# ``ScenarioEngine`` runner type.
"""
from __future__ import annotations

import re
from enum import Enum

from .scenarios import QueryScenario


class ScenarioEngine(Enum):
    POSTGRES = "postgres"
    SQLITE = "sqlite"
    MYSQL = "mysql"

    @property
    def schema_artifact(self) -> str:
        """The schema artifact, relative to the corpus root."""
        return f"canonical/schema.{self.value}.sql"

    def seed(self, scenario: QueryScenario) -> str | None:
        """The scenario's seed SQL spelled for this engine, or ``None``."""
        own = (scenario.seed_data_engine or {}).get(self.value)
        if own is not None:
            return own
        if self is ScenarioEngine.MYSQL and scenario.seed_data:
            return to_mysql_seed(scenario.seed_data)
        return scenario.seed_data


_UTC_INSTANT = re.compile(r"'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z'")


def to_mysql_seed(seed: str) -> str:
    """Postgres-quoted seed SQL to MySQL.

    Walks the text once so a double quote INSIDE a single-quoted string (a JSON payload) is
    left alone and only a double-quoted identifier is rewritten to backticks; a UTC instant
    literal loses its ``Z`` (a DATETIME holds the UTC wall clock).
    """
    out: list[str] = []
    in_string = False
    in_ident = False
    i = 0
    while i < len(seed):
        c = seed[i]
        if in_string:
            out.append(c)
            if c == "'":
                if i + 1 < len(seed) and seed[i + 1] == "'":
                    out.append("'")
                    i += 1
                else:
                    in_string = False
        elif in_ident:
            if c == '"':
                out.append("`")
                in_ident = False
            else:
                out.append(c)
        elif c == "'":
            in_string = True
            out.append(c)
        elif c == '"':
            in_ident = True
            out.append("`")
        else:
            out.append(c)
        i += 1
    return _UTC_INSTANT.sub(r"'\1'", "".join(out))


def split_statements(script: str) -> list[str]:
    """The statements of a script: split on a ``;`` at the end of a line (no body carries one
    mid-line), after dropping comment-only lines. SQLite and MySQL drivers run one statement
    per call."""
    kept = "\n".join(ln for ln in script.splitlines() if not ln.lstrip().startswith("--"))
    return [s.strip() for s in re.split(r";[ \t]*(?:\n|$)", kept) if s.strip()]
