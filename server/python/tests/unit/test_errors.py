import json
from pathlib import Path

from metaobjects.errors import ErrorCode, MetaError


def _corpus_codes() -> set[str]:
    root = Path(__file__).resolve()
    while not (root / "fixtures" / "conformance").is_dir():
        assert root != root.parent, "could not locate fixtures/conformance"
        root = root.parent
    raw = json.loads((root / "fixtures" / "conformance" / "ERROR-CODES.json").read_text())
    return set(raw["codes"].keys())


def test_error_code_enum_covers_corpus_codes() -> None:
    defined = {c.name for c in ErrorCode}
    missing = _corpus_codes() - defined
    assert not missing, f"ErrorCode is missing corpus codes: {sorted(missing)}"


def test_meta_error_carries_code() -> None:
    err = MetaError("bad thing", ErrorCode.ERR_UNKNOWN_TYPE)
    assert err.code is ErrorCode.ERR_UNKNOWN_TYPE
    assert err.message == "bad thing"
