from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from metaobjects.api_settings import (
    API_KEY_PAGINATION,
    API_KEY_UNKNOWN_FIELDS,
    PAGINATION_KEY_DEFAULT_LIMIT,
    PAGINATION_KEY_MAX_LIMIT,
    UNKNOWN_FIELDS_MODES,
    UNKNOWN_FIELDS_REJECT,
    ApiPagination,
    ApiSettings,
)
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.naming import (
    NamingRules,
    registered_column_naming_strategies,
    registered_pluralizers,
    registered_table_naming_rules,
    unknown_naming_strategy_message,
)
from metaobjects.wire import WIRE_DECIMALS, WIRE_DURATIONS, WIRE_NULL_MEMBERS, WireFormat

#: The DEFAULT value of `sources` when the key is absent or empty — never a
#: requirement, and never assumed to exist by any other code path.
DEFAULT_METADATA_DIR = "metaobjects"

_METAOBJECTS_DIR = ".metaobjects"
_CONFIG_FILE = "config.json"

#: `/^[a-z0-9][a-z0-9._-]*$/` — mirrors the TS `DependencyName` regex in
#: `sdk/src/dependencies.ts` exactly (DESIGN §3.1).
_DEPENDENCY_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

#: The one transport key a dependency spec may carry.
_DEPENDENCY_TRANSPORT_KEYS = ("path", "npm", "python", "maven", "nuget")

#: The packaged transports name a package in a local cache that holds many versions, so they
#: also carry the `version` to look up.
_VERSIONED_TRANSPORTS = ("maven", "nuget")


@dataclass(frozen=True)
class NeutralConfig:
    """The port-neutral subset of `.metaobjects/config.json`."""

    #: Raw source specs, each a single-key mapping (`path` / `resource` / `package`).
    sources: list[dict[str, str]]

    #: Declared metadata dependencies (FR-023) — each dict already validated:
    #: `name`, exactly one transport key (`path` / `npm` / `python` / `maven` /
    #: `nuget`), a `version` beside `maven`/`nuget`, optional `dir` beside any but `path`.
    dependencies: list[dict[str, str]]

    #: FR-023 §11.1 item 2 — the user's declared `scope.include` patterns, READ
    #: ONLY for the explicit-include rule (`explicitly_includes`): a dependency's
    #: package survives selection only when one of these patterns NAMES it
    #: literally. Unlike TypeScript, the Python CLI has never applied `scope` to
    #: its OWN objects (no caller of `matches_scope`/`compile_scope` exists in
    #: `server/python/src` before this) — `scope.exclude` is therefore not read
    #: at all, and adding that would be new behaviour, not parity (T18 ruling).
    #: Empty when `scope` / `scope.include` is absent.
    scope_include: list[str]

    #: FR-023 §11.1 item 2 — the user's declared `migrate.scope` patterns
    #: (include-only, same grammar as `scope.include`), or `None` when the key
    #: is absent. Mirrors TS `migrate.scope` for completeness — nothing in the
    #: Python CLI's own `gen`/`verify --codegen` path consumes it (schema is
    #: TS-owned, ADR-0015); it exists so `Collection.in_migrate_scope` can be
    #: built with full TS parity.
    migrate_scope: list[str] | None

    #: FR-043 §12 Q4 — MetaObjects-shipped library packages this project opts
    #: into (e.g. ``["iam", "iam/db"]``). Declared HERE, beside `dependencies` —
    #: the port-neutral surface every port reads — not in a per-port config, so
    #: which designs a project adopts is a fact about the PROJECT, read at every
    #: rung of the source ladder (DESIGN §2.3), same as `dependencies`/`scope`.
    #: Each token is validated against this build's shipped tokens
    #: (`known_tokens()`) here, not left to `library_sources()` (which skips an
    #: unrecognised token silently, on purpose, for a programmatic caller) — a
    #: name typed into a config file is a mistake worth failing on loudly,
    #: rather than resurfacing later as `ERR_UNRESOLVED_SUPER` against the
    #: adopter's own metadata, the wrong place to go looking.
    libraries: list[str]

    #: ADR-0058 — the ONE project physical-naming setting. Absent or `{}` ⇒ both
    #: rules default to `snake_case`. The loader attaches this to the loaded root
    #: (`MetaRoot.naming`) so every resolver — codegen, the runtime, `verify` —
    #: reads the SAME values. Validated HERE (unknown key / unknown value / a
    #: non-object `naming` all raise) because an unparseable project setting should
    #: fail the load loudly, not silently fall back to the default and rename
    #: every column.
    naming: NamingRules

    #: ADR-0019 Amendment 2 — the `wire` block: the OUTPUT form of a generated REST
    #: surface (decimals, value-object null members). Absent or `{}` ⇒ `native` for both.
    #: Attached to the loaded root (`MetaRoot.wire`) beside `naming`; validated HERE
    #: for the same reason `naming` is.
    wire: WireFormat = WireFormat()

    #: FR-023 — `requirements.inherit`: scope patterns naming the dependencies whose
    #: requirements this project takes on as its own ledger (`Collection.in_ledger`).
    requirements_inherit: list[str] = field(default_factory=list)

    #: The `api` block: `api.pagination` (default page size and cap of a generated list route) and
    #: `api.unknownFields` (`reject` | `drop`). Attached to the loaded root (`MetaRoot.api`).
    api: ApiSettings = ApiSettings()


def find_project_dir(start: Path) -> Path | None:
    """The nearest directory at or above *start* that holds ``.metaobjects/config.json``,
    or ``None``. THE project-config finder for a load that is handed a metadata
    location rather than a project (``load_directory`` / ``load_uris``): the project
    is wherever the setting is, however deep the metadata directory sits."""
    here = start.resolve()
    for candidate in (here, *here.parents):
        if (candidate / _METAOBJECTS_DIR / _CONFIG_FILE).is_file():
            return candidate
    return None


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

    dependencies_raw = raw.get("dependencies", [])
    if not isinstance(dependencies_raw, list):
        raise ParseError(
            f"{path}: 'dependencies' must be an array",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    dependencies = [_validate_dependency_spec(d, path) for d in dependencies_raw]
    names = [d["name"] for d in dependencies]
    if len(set(names)) != len(names):
        raise ParseError(
            f"{path}: 'dependencies' names must be unique",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    scope_include = _read_scope_include(raw, path)
    migrate_scope = _read_migrate_scope(raw, path)
    libraries = _read_libraries(raw, path)
    naming = _read_naming(raw, path)
    wire = _read_wire(raw, path)
    api = _read_api(raw, path)
    _check_enums(raw, path)
    requirements_inherit = _read_requirements_inherit(raw, path)

    # Unknown top-level keys are IGNORED by design — see the module docstring.
    return NeutralConfig(
        sources=[dict(s) for s in sources],
        dependencies=dependencies,
        scope_include=scope_include,
        migrate_scope=migrate_scope,
        libraries=libraries,
        naming=naming,
        wire=wire,
        requirements_inherit=requirements_inherit,
        api=api,
    )


def _read_requirements_inherit(raw: dict[str, object], path: Path) -> list[str]:
    """FR-023 — `requirements.inherit`, the dependencies whose requirements join this
    project's ledger. Validated like `naming`: an unknown key inside `requirements` is
    refused, because a misspelt `inherit` would silently leave the ledger out.
    """
    block = raw.get("requirements")
    if block is None:
        return []
    if not isinstance(block, dict):
        raise ParseError(f"{path}: 'requirements' must be an object", code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    unknown = sorted(k for k in block if k != "inherit")
    if unknown:
        raise ParseError(
            f"{path}: 'requirements' has unknown key(s) {unknown}; accepted: ['inherit']",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    inherit = block.get("inherit")
    if inherit is None:
        return []
    return _string_array_or_raise(inherit, "requirements.inherit", path)


def _string_array_or_raise(value: object, field: str, path: Path) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ParseError(
            f"{path}: '{field}' must be an array of non-empty strings",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    return list(value)


def _read_scope_include(raw: dict[str, object], path: Path) -> list[str]:
    """FR-023 §11.1 item 2 — `scope.include`, read only for the explicit-include
    rule. `scope.exclude` and every other key inside `scope` are ignored, same
    tolerance the module docstring already grants unknown TOP-level keys: this
    port models the neutral subset it actually consumes, not the whole
    TypeScript-owned `scope` vocabulary.
    """
    scope = raw.get("scope")
    if scope is None:
        return []
    if not isinstance(scope, dict):
        raise ParseError(f"{path}: 'scope' must be an object", code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    include = scope.get("include")
    if include is None:
        return []
    return _string_array_or_raise(include, "scope.include", path)


def _read_migrate_scope(raw: dict[str, object], path: Path) -> list[str] | None:
    """FR-023 §11.1 item 2 — `migrate.scope`, read for completeness
    (`Collection.in_migrate_scope`). Every other key inside `migrate`
    (`dialect`, `outDir`, ...) is TypeScript-owned and ignored — see
    `test_unknown_top_level_keys_are_ignored`.
    """
    migrate = raw.get("migrate")
    if migrate is None:
        return None
    if not isinstance(migrate, dict):
        raise ParseError(f"{path}: 'migrate' must be an object", code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    scope = migrate.get("scope")
    if scope is None:
        return None
    return _string_array_or_raise(scope, "migrate.scope", path)


def _read_libraries(raw: dict[str, object], path: Path) -> list[str]:
    """FR-043 §12 Q4 — `libraries`, this project's opted-in shipped-library
    tokens. Empty when the key is absent. Each token is validated against
    `known_tokens()` (mirrors the TS `resolveCollection`'s `ERR_UNKNOWN_LIBRARY`
    check in `collection.ts`) — TOKENS, not library names, so an adopter who
    typed `iam/database` is shown `iam/db` rather than only the half they got
    right.
    """
    libraries = raw.get("libraries", [])
    libraries = _string_array_or_raise(libraries, "libraries", path)
    if not libraries:
        return libraries

    # Local import: keeps `metaobjects.library` (and the embedded-library module
    # it pulls in) off this module's import path for the common case of a
    # config declaring no libraries at all.
    from metaobjects.library.library_sources import known_tokens

    available = known_tokens()
    unknown = [name for name in libraries if name not in available]
    if unknown:
        raise ParseError(
            f"{path}: 'libraries' names unknown "
            f"librar{'y' if len(unknown) == 1 else 'ies'} {unknown}; "
            f"available: {available}",
            code=ErrorCode.ERR_UNKNOWN_LIBRARY,
        )
    return libraries


#: Every key the `naming` block accepts, and the ONLY ones it accepts (ADR-0058
#: Decision 1 — an unknown key is refused, not ignored, unlike unknown TOP-level keys).
_NAMING_KEYS = ("columns", "tables", "collections")


def _read_naming(raw: dict[str, object], path: Path) -> NamingRules:
    """ADR-0058 — the `naming` block: one project physical-naming setting, read by
    every port. Absent ⇒ both rules default (`snake_case`/`snake_case`); `{}` is
    the SAME as absent (every key optional). Refuses a non-object `naming`, an
    unknown key inside it, or a name no registered strategy answers —
    never falls back to the default on a mistake, which would silently rename
    every column or table the next time metadata is read.
    """
    naming = raw.get("naming")
    if naming is None:
        return NamingRules()
    if not isinstance(naming, dict):
        raise ParseError(
            f"{path}: 'naming' must be an object, e.g. {{\"columns\": \"snake_case\"}}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    unknown = sorted(set(naming) - set(_NAMING_KEYS))
    if unknown:
        raise ParseError(
            f"{path}: 'naming' has unknown key(s) {unknown}; accepted: {list(_NAMING_KEYS)}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    # ADR-0058 Amendment 1: a value is the NAME of a registered strategy, a built-in or one
    # the application registered before this read. A name nothing answers is refused here.
    columns = naming.get("columns", NamingRules.columns)
    if not isinstance(columns, str) or columns not in registered_column_naming_strategies():
        raise ParseError(
            f"{path}: {unknown_naming_strategy_message('columns', str(columns))}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    tables = naming.get("tables", NamingRules.tables)
    if not isinstance(tables, str) or tables not in registered_table_naming_rules():
        raise ParseError(
            f"{path}: {unknown_naming_strategy_message('tables', str(tables))}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    collections = naming.get("collections", NamingRules.collections)
    if collections is not None and (
        not isinstance(collections, str) or collections not in registered_pluralizers()
    ):
        raise ParseError(
            f"{path}: {unknown_naming_strategy_message('collections', str(collections))}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    return NamingRules(columns=columns, tables=tables, collections=collections)


#: Every key the `enums` block accepts, and the ONLY ones it accepts (refused, not ignored, like `naming`).
_ENUMS_KEYS = ("maxLength",)


def _check_enums(raw: dict[str, object], path: Path) -> None:
    """The `enums` block: `maxLength`, a positive integer, is the column length a port that
    sizes a string-stored enum's column gives one with no @maxLength. This port sizes no
    column (it emits no DDL and no column type), so it reads nothing from the block, but a
    project shared with a port that does has one: the block is accepted, and its shape is
    checked so a typo is refused here as it is there (a non-object block, an unknown key, or
    a value that is not a positive integer)."""
    if "enums" not in raw:
        return
    enums = raw["enums"]
    if not isinstance(enums, dict):
        raise ParseError(f"{path}: 'enums' must be an object", code=ErrorCode.ERR_BAD_ATTR_VALUE)
    unknown = sorted(set(enums) - set(_ENUMS_KEYS))
    if unknown:
        raise ParseError(
            f"{path}: 'enums' has unknown key(s) {unknown}; accepted: {list(_ENUMS_KEYS)}",
            code=ErrorCode.ERR_BAD_ATTR_VALUE,
        )
    if "maxLength" not in enums:
        return
    value = enums["maxLength"]
    # A whole number however JSON spells it (32, 32.0, 1e2): a reader that parses numbers as
    # doubles (TypeScript's) cannot tell those apart, so every port accepts all three.
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ParseError(
            f"{path}: 'enums.maxLength' must be a positive integer, got {value!r}",
            code=ErrorCode.ERR_BAD_ATTR_VALUE,
        )


_PAGE_SIZE_MAX = 2147483647


def _page_size(value: object, key: str, path: Path) -> int:
    """A positive whole number however JSON spells it (50, 50.0), never a bool, at most
    2147483647 so every port's integer type holds it (the shared corpus
    ``fixtures/api-contract-conformance/api-settings/config-blocks.json``)."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= _PAGE_SIZE_MAX:
        raise ParseError(
            f'{path}: "api.pagination.{key}" must be a positive integer',
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    return value


def _read_api(raw: dict[str, object], path: Path) -> ApiSettings:
    """The `api` block. Absent or `{}` => no page size and `reject`. A mistake is refused here
    rather than falling back to a default that changes what a route answers."""
    if "api" not in raw:
        return ApiSettings()
    api = raw["api"]
    if not isinstance(api, dict):
        raise ParseError(f'{path}: "api" must be an object', code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    for key in api:
        if key not in (API_KEY_PAGINATION, API_KEY_UNKNOWN_FIELDS):
            raise ParseError(
                f'{path}: "api" has an unknown key "{key}" '
                f'(expected "{API_KEY_PAGINATION}" or "{API_KEY_UNKNOWN_FIELDS}")',
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
    pagination: ApiPagination | None = None
    if API_KEY_PAGINATION in api:
        block = api[API_KEY_PAGINATION]
        if not isinstance(block, dict):
            raise ParseError(f'{path}: "api.pagination" must be an object', code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
        for key in block:
            if key not in (PAGINATION_KEY_DEFAULT_LIMIT, PAGINATION_KEY_MAX_LIMIT):
                raise ParseError(
                    f'{path}: "api.pagination" has an unknown key "{key}" '
                    f'(expected "{PAGINATION_KEY_DEFAULT_LIMIT}" and "{PAGINATION_KEY_MAX_LIMIT}")',
                    code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
                )
        for key in (PAGINATION_KEY_DEFAULT_LIMIT, PAGINATION_KEY_MAX_LIMIT):
            if key not in block:
                raise ParseError(
                    f'{path}: "api.pagination" needs both "{PAGINATION_KEY_DEFAULT_LIMIT}" '
                    f'and "{PAGINATION_KEY_MAX_LIMIT}"',
                    code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
                )
        default_limit = _page_size(block[PAGINATION_KEY_DEFAULT_LIMIT], PAGINATION_KEY_DEFAULT_LIMIT, path)
        max_limit = _page_size(block[PAGINATION_KEY_MAX_LIMIT], PAGINATION_KEY_MAX_LIMIT, path)
        if default_limit > max_limit:
            raise ParseError(
                f'{path}: "api.pagination.defaultLimit" must not exceed "api.pagination.maxLimit"',
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
        pagination = ApiPagination(default_limit=default_limit, max_limit=max_limit)
    unknown_fields = api.get(API_KEY_UNKNOWN_FIELDS, UNKNOWN_FIELDS_REJECT)
    if not isinstance(unknown_fields, str) or unknown_fields not in UNKNOWN_FIELDS_MODES:
        choices = " or ".join(f'"{m}"' for m in UNKNOWN_FIELDS_MODES)
        raise ParseError(
            f'{path}: "api.{API_KEY_UNKNOWN_FIELDS}" must be {choices}',
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    return ApiSettings(pagination=pagination, unknown_fields=unknown_fields)


#: Every key the `wire` block accepts, and the ONLY ones it accepts (refused, not ignored, like `naming`).
_WIRE_KEYS = ("decimals", "nullMembers", "durations")


def _read_wire(raw: dict[str, object], path: Path) -> WireFormat:
    """ADR-0019 Amendment 2 — the `wire` block. Absent or `{}` ⇒ `native` for every key.
    Refuses a non-object `wire`, an unknown key, or a value outside the closed set a key
    accepts: a mistake must not silently fall back to the default and change the JSON an
    API writes."""
    if "wire" not in raw:
        return WireFormat()
    wire = raw["wire"]
    if not isinstance(wire, dict):
        raise ParseError(f'{path}: "wire" must be an object', code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    for key in wire:
        if key not in _WIRE_KEYS:
            raise ParseError(
                f'{path}: "wire" has an unknown key "{key}" (expected "decimals", "nullMembers" and/or "durations")',
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
    values: dict[str, str] = {}
    for key, allowed in (("decimals", WIRE_DECIMALS), ("nullMembers", WIRE_NULL_MEMBERS), ("durations", WIRE_DURATIONS)):
        value = wire.get(key, allowed[0])
        if not isinstance(value, str) or value not in allowed:
            choices = ", ".join(f'"{a}"' for a in allowed)
            raise ParseError(
                f'{path}: "wire.{key}" must be one of {choices}, got {json.dumps(value)}',
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
        values[key] = value
    return WireFormat(decimals=values["decimals"], null_members=values["nullMembers"], durations=values["durations"])


def _validate_dependency_spec(dep: object, path: Path) -> dict[str, str]:
    """Validate one entry of `dependencies` (DESIGN §3.1) and return it
    normalized. Mirrors the TS `DependencySpecSchema` union in
    `sdk/src/dependencies.ts` exactly: a `name`, exactly one transport key
    (`path` | `npm` | `python`), an optional `dir` that is legal only beside
    `npm`/`python`, and no other keys. `mode` is REMOVED (FR-023 §11.3 —
    superseded by explicit `scope.include`); any `mode` key is now an
    unknown-key error like any other unrecognized key.
    """

    def fail(reason: str) -> ParseError:
        return ParseError(
            f"{path}: invalid 'dependencies' entry ({reason})",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    if not isinstance(dep, dict):
        raise fail("must be an object")

    name = dep.get("name")
    if not isinstance(name, str) or not _DEPENDENCY_NAME_RE.match(name):
        raise fail("'name' must match ^[a-z0-9][a-z0-9._-]*$")

    transports = [k for k in _DEPENDENCY_TRANSPORT_KEYS if k in dep]
    if len(transports) != 1:
        raise fail("exactly one of 'path' / 'npm' / 'python' / 'maven' / 'nuget' is required")
    transport = transports[0]

    transport_value = dep[transport]
    if not isinstance(transport_value, str) or not transport_value.strip():
        raise fail(f"'{transport}' must be a non-empty string")

    allowed_keys = {"name", transport}
    if transport != "path":
        allowed_keys.add("dir")
    if transport in _VERSIONED_TRANSPORTS:
        allowed_keys.add("version")
    extra_keys = set(dep.keys()) - allowed_keys
    if extra_keys:
        raise fail(f"unknown key(s): {sorted(extra_keys)}")

    result: dict[str, str] = {"name": name, transport: transport_value}

    if transport in _VERSIONED_TRANSPORTS:
        version = dep.get("version")
        if not isinstance(version, str) or not version.strip():
            raise fail(f"'version' is required beside '{transport}' and must be a non-empty string")
        result["version"] = version

    if "dir" in dep:
        dir_value = dep["dir"]
        if not isinstance(dir_value, str) or not dir_value.strip():
            raise fail("'dir' must be a non-empty string")
        result["dir"] = dir_value

    return result
