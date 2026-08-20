from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from metaobjects.errors import ErrorCode, ParseError

#: The DEFAULT value of `sources` when the key is absent or empty — never a
#: requirement, and never assumed to exist by any other code path.
DEFAULT_METADATA_DIR = "metaobjects"

_METAOBJECTS_DIR = ".metaobjects"
_CONFIG_FILE = "config.json"


@dataclass(frozen=True)
class NeutralConfig:
    """The port-neutral subset of `.metaobjects/config.json`."""

    #: Raw source specs, each a single-key mapping (`path` / `resource` / `package`).
    sources: list[dict[str, str]]


def read_neutral_config(config_dir: Path) -> NeutralConfig | None:
    """Read the neutral subset from ``config_dir/.metaobjects/config.json``.

    Returns ``None`` when the file does not exist. A file that EXISTS but is
    malformed raises — swallowing it would make a typo'd config behave
    identically to no config at all, silently resolving a possibly-stale
    default directory with no diagnostic.
    """
    path = config_dir / _METAOBJECTS_DIR / _CONFIG_FILE
    if not path.is_file():
        return None

    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise ParseError(
            f"{path} exists but could not be read as JSON: {e}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        ) from e

    if not isinstance(raw, dict):
        raise ParseError(
            f"{path} must contain a JSON object",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    version = raw.get("schema_version")
    # `isinstance(version, bool)` must be checked FIRST and separately: Python's
    # `bool` is a subclass of `int` and `True == 1`, so a bare `version != 1`
    # check accepts `schema_version: true` — a divergence from Java's
    # `isNumber()` and C#'s `ValueKind != Number`, both of which reject a JSON
    # boolean outright.
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version != 1:
        raise ParseError(
            f"{path}: unsupported schema_version {version!r} (expected 1)",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    # `.get("sources", [])` only applies the [] default when the key is ABSENT —
    # a present `sources: null` returns None here, which correctly fails the
    # `isinstance(sources, list)` check below rather than silently reading as
    # "absent" and falling back to the default directory with no diagnostic.
    sources = raw.get("sources", [])
    if not isinstance(sources, list) or not all(
        isinstance(s, dict)
        and len(s) == 1
        # Every source-spec value (`path`/`resource`/`package`) must be a
        # non-empty (after stripping whitespace) string — a bare number/
        # boolean/null would otherwise reach `Path()` downstream and raise an
        # uncaught TypeError instead of this coded error, and an empty or
        # whitespace-only `path` would resolve to the config-holding directory
        # itself rather than failing loudly on the typo'd config.
        and all(isinstance(v, str) and v.strip() for v in s.values())
        for s in sources
    ):
        raise ParseError(
            f"{path}: 'sources' must be an array of single-key objects, each "
            "value a non-empty string",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    # Unknown top-level keys are IGNORED by design — see the module docstring.
    return NeutralConfig(sources=[dict(s) for s in sources])
