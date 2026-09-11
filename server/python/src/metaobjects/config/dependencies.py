"""FR-023 — metadata dependencies: constants shared by the `dependencies` key
of `.metaobjects/config.json` (DESIGN §3.1) and by later tasks (manifest,
lock, snapshot, sync). Mirrors
`server/typescript/packages/sdk/src/dependencies.ts` — constants only here;
resolving a declared dependency to bytes on disk lands in a later task.
"""
from __future__ import annotations

#: Directory (under `.metaobjects/`) holding the synced snapshot artifacts,
#: one subdirectory per dependency name: `.metaobjects/deps/<name>/`.
DEPS_DIR = "deps"

#: `meta deps sync`'s output — the only writer (DESIGN §3.3).
LOCK_FILE = "deps.lock.json"

#: D10 co-development override — never committed (DESIGN §10 D10).
LOCAL_OVERRIDE_FILE = "deps.local.json"

#: The publisher-generated manifest sitting beside a dependency's artifact
#: (DESIGN §3.2).
MANIFEST_FILE = "metaobjects.pkg.json"

#: Suffix of a dependency's canonical-JSON artifact file, e.g.
#: `acme-common.metaobjects.json` (DESIGN §3.5).
ARTIFACT_SUFFIX = ".metaobjects.json"

#: Prefix of a dependency artifact's source id: `dep:<name>/<artifact>`
#: (DESIGN §2.3, "Source ids").
DEPENDENCY_SOURCE_ID_PREFIX = "dep:"

#: Prefix of the `integrity` field's value: `"sha256-" + lowercase hex sha256
#: of the artifact bytes` (DESIGN §3, "Hash format").
INTEGRITY_PREFIX = "sha256-"

#: The two modes a declared dependency may run in (DESIGN §2.4, §2.7).
DEPENDENCY_MODES = ("reference", "own")

#: `mode`'s default when a dependency spec omits it.
DEFAULT_DEPENDENCY_MODE = "reference"
