"""SP-D Unit 4 — runtime return-type gate (Python port).

Pins ADR-0019: the ``ObjectManager`` runtime returns NATIVE, in-process Python
types from its query path — NOT canonicalized wire-strings. Wire
canonicalization (the ``normalization.py`` forms) is a boundary concern applied
by the persistence runner, never inside the runtime. Unit 3 moved
``_coerce_for_contract`` out of ``ObjectManager`` into the runner, so the
runtime now hands back pg8000's own native types.

This reads the dict ``ObjectManager.find_by_id`` returns BEFORE any
normalization and asserts each native type:

- ``Measurement.id`` (BIGINT)         → ``int``       (a native integer).
- ``Measurement.preciseKg`` (NUMERIC) → ``Decimal``   (exact native decimal).
- ``Asset.recordedAt`` (TIMESTAMPTZ)  → ``datetime``  (native temporal, NOT str).
- ``Asset.payload`` (jsonb)           → ``dict``      (pg8000 decodes jsonb to a
  native dict, NOT a raw JSON str).

Per-port gate (native types differ per language), not a byte-identical
cross-port corpus. Catches the Python-outlier class of regression — the exact
class of bug Unit 3 fixed: a runtime baking wire-strings into its query path.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime
from decimal import Decimal

import pg8000.dbapi as pg8000

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, PostgresDriver

from .postgres_container import PostgresContainer
from .query_runner import _apply_schema_artifact, SCHEMA_ARTIFACT_FILE
from .scenarios import find_corpus_root

_MEASUREMENT_SEED = """
INSERT INTO "measurements" ("id","tempC","massKg","preciseKg")
VALUES (1, 1.5, 0.125, 12.5000);
"""

_ASSET_SEED = """
INSERT INTO "assets"
  ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime")
VALUES
  ('11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '22222222-2222-4222-8222-222222222222',
   '{"b": 2, "a": 1}',
   '2026-05-30T14:30:00.123Z', '2026-05-30T14:30:00.123', '2026-05-30', '14:30:00.123');
"""


def _execute(info, sql: str) -> None:
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        cur = conn.cursor()
        try:
            cur.execute(sql)
            conn.commit()
        finally:
            cur.close()


def test_runtime_returns_native_types_not_wire_strings() -> None:
    corpus = find_corpus_root()
    canonical_dir = corpus / "canonical"

    with PostgresContainer() as pg:
        info = pg.info()

        # Provision schema from the committed TS-produced DDL (ADR-0015) + seed rows.
        _apply_schema_artifact(info, canonical_dir / SCHEMA_ARTIFACT_FILE)
        _execute(info, _MEASUREMENT_SEED)
        _execute(info, _ASSET_SEED)

        result = load_directory(canonical_dir)
        assert not result.errors, result.errors

        with closing(pg8000.connect(
            host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
        )) as conn:
            om = ObjectManager(result.root, PostgresDriver(conn))

            # --- Measurement: native integer + native exact decimal ---------------
            m = om.find_by_id("Measurement", 1)
            assert m is not None, "expected the seeded Measurement row"

            id_value = m["id"]
            assert isinstance(id_value, int) and not isinstance(id_value, bool), (
                f"field.long Measurement.id must be a native int, got: {type(id_value)!r} "
                "(wire-string regression?)"
            )

            precise_kg = m["preciseKg"]
            assert isinstance(precise_kg, Decimal), (
                "field.decimal Measurement.preciseKg must be a native exact Decimal "
                f"(ADR-0019 / SP-D Unit 3), got: {type(precise_kg)!r}"
            )

            # --- Asset: native temporal + native jsonb dict ----------------------
            a = om.find_by_id("Asset", "11111111-1111-4111-8111-111111111111")
            assert a is not None, "expected the seeded Asset row"

            recorded_at = a["recordedAt"]
            assert isinstance(recorded_at, datetime), (
                "field.timestamp Asset.recordedAt (TIMESTAMPTZ) must be a native datetime, "
                f"NOT a str. Got: {type(recorded_at)!r}"
            )
            assert not isinstance(recorded_at, str), "Asset.recordedAt must not be a wire-string"

            payload = a["payload"]
            assert isinstance(payload, dict), (
                "field.string @dbColumnType:jsonb Asset.payload must be a native dict "
                f"(pg8000 decodes jsonb), NOT a raw JSON str. Got: {type(payload)!r}"
            )
