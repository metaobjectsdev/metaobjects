"""``library_packages()`` — the package set that decides whether a requirement came from a
shipped library (and so whether object coverage is measured at all).

It is read from the manifests embedded in the wheel. This test holds it to the manifests the
repository ships, so a library added under ``library/`` without re-embedding, or a package
added to one manifest, cannot leave the two disagreeing.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.library import library_packages

_LIBRARY_DIR = Path(__file__).resolve().parents[4] / "library"


def test_library_packages_is_exactly_the_packages_of_the_shipped_manifests() -> None:
    manifests = sorted(_LIBRARY_DIR.glob("*/library.json"))
    assert manifests, f"no library manifest under {_LIBRARY_DIR}"
    expected = {pkg for manifest in manifests for pkg in json.loads(manifest.read_text())["packages"]}
    assert expected  # a manifest that declares no package would make this test vacuous
    assert library_packages() == expected
