"""The ``api`` block of ``.metaobjects/config.json``: ``api.pagination`` and ``api.unknownFields``."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.api_settings import ApiPagination, ApiSettings
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ParseError


def _read(tmp_path: Path, api: object | None) -> ApiSettings:
    cfg: dict[str, object] = {"schema_version": 1}
    if api is not None:
        cfg["api"] = api
    (tmp_path / ".metaobjects").mkdir(exist_ok=True)
    (tmp_path / ".metaobjects" / "config.json").write_text(json.dumps(cfg))
    neutral = read_neutral_config(tmp_path)
    assert neutral is not None
    return neutral.api


def test_absent_block_is_unpaged_and_rejects(tmp_path: Path) -> None:
    assert _read(tmp_path, None) == ApiSettings(pagination=None, unknown_fields="reject")


def test_a_full_block_is_read(tmp_path: Path) -> None:
    api = _read(tmp_path, {"pagination": {"defaultLimit": 50, "maxLimit": 1000}, "unknownFields": "drop"})
    assert api == ApiSettings(pagination=ApiPagination(50, 1000), unknown_fields="drop")


@pytest.mark.parametrize(
    "api,message",
    [
        ({"pagination": {"defaultLimit": 0, "maxLimit": 10}}, '"api.pagination.defaultLimit" must be a positive integer'),
        ({"pagination": {"defaultLimit": 5, "maxLimit": 1.5}}, '"api.pagination.maxLimit" must be a positive integer'),
        ({"pagination": {"defaultLimit": True, "maxLimit": 10}}, '"api.pagination.defaultLimit" must be a positive integer'),
        ({"pagination": {"defaultLimit": 11, "maxLimit": 10}}, '"api.pagination.defaultLimit" must not exceed "api.pagination.maxLimit"'),
        ({"pagination": {"defaultLimit": 5}}, 'needs both "defaultLimit" and "maxLimit"'),
        ({"unknownFields": "ignore"}, '"api.unknownFields" must be "reject" or "drop"'),
        ({"paging": {}}, '"api" has an unknown key "paging"'),
        ([], '"api" must be an object'),
    ],
)
def test_a_bad_block_names_the_key(tmp_path: Path, api: object, message: str) -> None:
    with pytest.raises(ParseError, match=message.replace("(", r"\(")):
        _read(tmp_path, api)
