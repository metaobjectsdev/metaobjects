"""``metaobjects verify`` — the field AUTHORING lint.

Two metadata mistakes about an object's FIELDS load with no error on every port:

1. An ``identity.reference`` whose ``@fields`` names a field the object does not
   have. The loader resolves ``@references`` (the target) and never looks at
   ``@fields``, so a typo there produces a foreign key over a column nothing declares.
2. Two ``field.*`` children with the same ``name`` in one object's ``children`` list.

WHY THESE ARE WARNINGS AND NOT LOAD ERRORS. ``docs/compatibility-policy.md`` does not
allow a new load error for metadata that loads today, so every finding here is a
warning by construction: nothing in this module reaches an exit code.

THE TWO HALVES READ DIFFERENT THINGS, and have to. The reference half reads the LOADED
model, because "does this object have that field" is a question about the EFFECTIVE
field set — inherited through ``extends`` and merged from overlay files. The duplicate
half reads the RAW DOCUMENTS: the TypeScript, C# and Java loaders fold a repeated
field into the first declaration, so their model keeps no trace of it, and one scan of
the document gives every port the same answer.

Mirrors the TS reference (``packages/cli/src/lib/field-lint.ts`` +
``packages/metadata/src/loader/declared-duplicate-fields.ts``). The codes, the message
text and the fixtures are shared: ``fixtures/field-lint-conformance/``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from metaobjects.loader.sources import FileSource
from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPE_REFERENCE,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.source.yaml_positions import parse_yaml_with_positions

#: An ``identity.reference`` lists a field its object does not have.
WARN_REFERENCE_FIELD_NOT_FOUND = "WARN_REFERENCE_FIELD_NOT_FOUND"
#: One ``children`` list declares the same field name more than once.
WARN_DUPLICATE_FIELD_NAME = "WARN_DUPLICATE_FIELD_NAME"

_KEY_NAME = "name"
_KEY_PACKAGE = "package"
_KEY_CHILDREN = "children"
_TYPE_SUBTYPE_SEP = "."
#: The YAML authoring sugar for ``isArray: true`` — a suffix on the wrapper key.
_ARRAY_SUFFIX = "[]"


@dataclass(frozen=True)
class FieldLintFinding:
    """One advisory finding: its code, the node's address, and the message."""

    code: str
    path: str
    message: str


def _quote(value: str) -> str:
    # The JSON string form, so the text is byte-identical to the other ports'.
    return json.dumps(value, ensure_ascii=False)


def lint_reference_fields(root: MetaData) -> list[FieldLintFinding]:
    """Report every ``identity.reference`` whose ``@fields`` names a field its object lacks."""
    out: list[FieldLintFinding] = []
    # OWN-ONLY (ADR-0039 sanctioned case): a root has no super, and its own children
    # are the declared objects.
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        address = obj.resolution_key()
        # RESOLVING: the effective field set — a field inherited through ``extends`` or
        # added by an overlay file is a field the object has.
        fields = {c.name for c in obj.children() if c.type == TYPE_FIELD}
        # OWN-ONLY (ADR-0039 sanctioned case): report each DECLARATION once, on the
        # object that declares it. The resolving ``children()`` would repeat an
        # inherited reference on every subtype.
        for identity in obj.own_children():
            if identity.type != TYPE_IDENTITY or identity.sub_type != IDENTITY_SUBTYPE_REFERENCE:
                continue
            # RESOLVING: ``@fields`` may itself be inherited through the identity's
            # ``extends`` (``attrs()`` resolves; ``attr()`` is own-only in this port).
            listed = identity.attrs().get(IDENTITY_ATTR_FIELDS)
            names = listed if isinstance(listed, list) else [listed] if isinstance(listed, str) else []
            for name in names:
                if not isinstance(name, str) or name in fields:
                    continue
                out.append(
                    FieldLintFinding(
                        WARN_REFERENCE_FIELD_NOT_FOUND,
                        f"{address}.{identity.name}",
                        f"identity.reference {_quote(identity.name)} lists {_quote(name)} in @fields, "
                        f"but {address} has no field of that name, inherited and overlaid fields "
                        "included. Nothing checks this at load, so the reference is built on a field "
                        "that does not exist. Rename the entry to an existing field, or declare the "
                        "field.",
                    )
                )
    return out


def _wrapper_type(key: str) -> str:
    """The TYPE segment of a wrapper key: ``field.string[]`` and bare ``field`` are both ``field``."""
    head = key.split(_TYPE_SUBTYPE_SEP, 1)[0]
    return head[: -len(_ARRAY_SUFFIX)] if head.endswith(_ARRAY_SUFFIX) else head


def _declared_name(body: object) -> str | None:
    """A node's declared name: the body's ``name``, or the body itself when YAML wrote a scalar."""
    name = body.get(_KEY_NAME) if isinstance(body, dict) else body
    return name if isinstance(name, str) and name != "" else None


def declared_duplicate_fields(content: str, format: str) -> list[FieldLintFinding]:
    """Structurally scan one document's raw content and report every field name a
    root-level object declares more than once in its own ``children`` list.

    Scope is ONE children list: a field redeclared by an overlay file, or by a subtype
    overriding an inherited field, is not in one list and is not a finding. Malformed
    shapes return ``[]``; a syntax error raises, as the parser's own would.
    """
    normalized = content[1:] if content.startswith("﻿") else content
    if format == "json":
        parsed = json.loads(normalized)
    elif format == "yaml":
        parsed = parse_yaml_with_positions(normalized)
    else:
        return []
    if not isinstance(parsed, dict):
        return []
    # JSON fuses the subtype onto the root key; sigil-free YAML may write the bare type.
    root_body = parsed.get(f"{TYPE_METADATA}{_TYPE_SUBTYPE_SEP}{SUBTYPE_ROOT}", parsed.get(TYPE_METADATA))
    if not isinstance(root_body, dict):
        return []
    raw_root_pkg = root_body.get(_KEY_PACKAGE)
    root_pkg = raw_root_pkg if isinstance(raw_root_pkg, str) else ""
    children = root_body.get(_KEY_CHILDREN)
    if not isinstance(children, list):
        return []

    out: list[FieldLintFinding] = []
    for child in children:
        if not isinstance(child, dict):
            continue
        for wrapper_key, body in child.items():
            if not isinstance(wrapper_key, str) or _wrapper_type(wrapper_key) != TYPE_OBJECT:
                continue
            if not isinstance(body, dict):
                continue
            name = _declared_name(body)
            members = body.get(_KEY_CHILDREN)
            if name is None or not isinstance(members, list):
                continue

            counts: dict[str, int] = {}
            for member in members:
                if not isinstance(member, dict):
                    continue
                for member_key, member_body in member.items():
                    if not isinstance(member_key, str) or _wrapper_type(member_key) != TYPE_FIELD:
                        continue
                    field_name = _declared_name(member_body)
                    if field_name is not None:
                        counts[field_name] = counts.get(field_name, 0) + 1

            # The resolution key the parser gives a root-level node: its own ``package``
            # (a ``::``-prefixed one is relative to the root's), else the root's.
            raw_own_pkg = body.get(_KEY_PACKAGE)
            if isinstance(raw_own_pkg, str) and raw_own_pkg != "":
                relative = root_pkg.strip() != "" and raw_own_pkg.startswith(PACKAGE_SEP)
                pkg = root_pkg + raw_own_pkg if relative else raw_own_pkg
            else:
                pkg = root_pkg
            address = f"{pkg}{PACKAGE_SEP}{name}" if pkg != "" else name
            for field_name, count in counts.items():
                if count > 1:
                    out.append(
                        FieldLintFinding(
                            WARN_DUPLICATE_FIELD_NAME,
                            f"{address}.{field_name}",
                            f"{address} declares the field {_quote(field_name)} {count} times in one "
                            "children list. Nothing reports this at load, and only the first "
                            "declaration is certain to take effect. Remove or rename the duplicate.",
                        )
                    )
    return out


def lint_duplicate_fields(files: Iterable[Path | str]) -> list[FieldLintFinding]:
    """Run :func:`declared_duplicate_fields` over each metadata file.

    Unreadable or unparsable files are skipped — the loader reports those itself.
    """
    out: list[FieldLintFinding] = []
    for path in files:
        try:
            source = FileSource(path)
            out.extend(declared_duplicate_fields(source.read(), source.format))
        except Exception:  # noqa: BLE001 — an advisory scan never breaks verify
            continue
    return out
