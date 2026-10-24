"""The project ``wire`` setting (ADR-0019 Amendment 2): the OUTPUT form of a generated REST surface.

``wire`` in ``.metaobjects/config.json`` (``{"decimals": ..., "nullMembers": ...}``) is read by
the same port-neutral reader as ``naming`` and carried by the loaded root (``MetaRoot.wire``);
codegen reads it with :func:`wire_of`. The default is ``native`` for both keys: what this
port's own serializer writes (Pydantic's ``str(Decimal)``, a value object as the runtime holds
it). ``"decimals": "string"`` and ``"nullMembers": "omit"`` give the portable form the
conformance corpora pin. INPUT rules (W2/W3) do not depend on this setting.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from metaobjects.meta.meta_data import MetaData

WIRE_NATIVE = "native"
WIRE_DECIMALS_STRING = "string"
WIRE_NULLS_EMIT = "emit"
WIRE_NULLS_OMIT = "omit"

#: The closed sets each key accepts, in the order the refusal message lists them.
WIRE_DECIMALS = (WIRE_NATIVE, WIRE_DECIMALS_STRING)
WIRE_NULL_MEMBERS = (WIRE_NATIVE, WIRE_NULLS_EMIT, WIRE_NULLS_OMIT)


@dataclass(frozen=True)
class WireFormat:
    """The resolved ``wire`` block. Trusted input: validation happens where the raw JSON is
    parsed (``metaobjects.config.neutral_config``)."""

    decimals: str = WIRE_NATIVE
    null_members: str = WIRE_NATIVE


def wire_of(node: "MetaData") -> WireFormat:
    """The :class:`WireFormat` in force for *node*: the loaded root's ``wire``, or the default
    for a root nobody attached project config to."""
    cur = node
    while cur.parent is not None:
        cur = cur.parent
    wire = getattr(cur, "wire", None)
    return wire if isinstance(wire, WireFormat) else WireFormat()


def wire_block(wire: WireFormat) -> str:
    """A wire format as the ``wire`` block that declares it."""
    return f'"wire": {{ "decimals": "{wire.decimals}", "nullMembers": "{wire.null_members}" }}'


def wire_candidates(used: WireFormat) -> list[WireFormat]:
    """Every wire format other than ``used``, in the order ``verify --codegen`` probes them."""
    return [
        candidate
        for d in WIRE_DECIMALS
        for n in WIRE_NULL_MEMBERS
        if (candidate := WireFormat(decimals=d, null_members=n)) != used
    ]


def attach_wire(root: "MetaData", project_dir: Path) -> "MetaData":
    """Set ``root.wire`` from *project_dir*'s ``.metaobjects/config.json`` and return *root*,
    for a load site that bypasses the CLI's collection ladder (a conformance harness)."""
    from metaobjects.config.neutral_config import read_neutral_config

    cfg = read_neutral_config(project_dir)
    root.wire = cfg.wire if cfg is not None else WireFormat()  # type: ignore[attr-defined]
    return root
