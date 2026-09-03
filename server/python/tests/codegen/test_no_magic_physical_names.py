"""NO MAGIC STRINGS — the Python half of the gate that makes "generated code
references the constant" checkable instead of asserted. Port of the TypeScript
``server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts``,
the C# ``NoMagicPhysicalNamesTests`` and the Kotlin ``NoMagicPhysicalNamesTest``.

METHOD — a DE-BLINDED fixture. Every physical name below is deliberately
impossible for a generator to produce by derivation: it is not the snake_case of
its field name, not the pluralization of its object name, and carries a
``zz_phys_`` prefix nothing else in the codebase uses. So a generator that embeds
a literal cannot be confused with one that derived the same string by
coincidence — if the token appears in a file, that file hard-coded it.

Every token carries its REACH — whether it is expected to travel as a constant
today, or is one of the categories this port still spells literally. A
``KNOWN_LITERAL`` is PINNED, not exempted: the gate asserts the literal is still
there, so the day a generator starts referencing the constant instead, the pin
fails and says "promote it". A known gap that stops being a gap without anyone
noticing is how a ledger rots.

Python's answer differs from the other ports' and the difference is the POINT of
running the gate here rather than reasoning about it: see
``test_no_generated_file_outside_the_names_module_spells_a_physical_name``.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import list_generators
from metaobjects.codegen.runner import run_gen
from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader


class Reach(Enum):
    """How a physical name is expected to reach generated output today."""

    #: Must travel as a names-module reference, and appear literally nowhere else.
    CONSTANT = "constant"
    #: Still spelled literally, for the reason on the row. Pinned, not exempted.
    KNOWN_LITERAL = "known_literal"


@dataclass(frozen=True)
class Token:
    literal: str
    should_use: str
    reach: Reach = Reach.CONSTANT
    why: str = ""


# ---------------------------------------------------------------------------
# The de-blinded fixture, kept in step with the other ports' gates so a reader can
# diff the coverage directly.
# ---------------------------------------------------------------------------
TABLE = "zz_phys_tbl_alpha"        # NOT pluralize(snake("Customer"))
COL_ID = "zz_phys_col_ident"       # NOT snake("id")
COL_EMAIL = "zz_phys_col_mail"     # NOT snake("email")
COL_FK = "zz_phys_col_owner"       # NOT snake("customerId")
ORDER_TABLE = "zz_phys_tbl_beta"   # NOT pluralize(snake("Order"))
ORDER_ID = "zz_phys_col_okey"
VIEW = "zz_phys_view_gamma"        # NOT "v_" + snake("CustomerSummary")
JSONB_COL = "zz_phys_col_blob"
VO_MEMBER_COL = "zz_phys_col_road"

TOKENS: tuple[Token, ...] = (
    Token(TABLE, "CUSTOMER_NAME"),
    Token(COL_ID, "CUSTOMER_ID_COLUMN"),
    Token(COL_EMAIL, "CUSTOMER_EMAIL_COLUMN"),
    Token(JSONB_COL, "CUSTOMER_PROFILE_COLUMN"),
    Token(ORDER_TABLE, "ORDER_NAME"),
    Token(ORDER_ID, "ORDER_ID_COLUMN"),
    Token(COL_FK, "ORDER_CUSTOMER_ID_COLUMN"),
    Token(VIEW, "CUSTOMER_SUMMARY_NAME"),
    # No KNOWN_LITERAL row: this port emits no physical name outside its names modules
    # AT ALL — not even the value-object member column the ORM-binding ports must spell
    # (see test_every_physical_name_that_escapes_is_a_declared_known_literal). VO_MEMBER_COL
    # is in the fixture precisely so that claim is tested rather than assumed.
)

MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.value": {
                    "name": "Address",
                    "children": [
                        {"field.string": {"name": "road", "@column": VO_MEMBER_COL}}
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Customer",
                    "children": [
                        {"source.rdb": {"@table": TABLE}},
                        {"field.long": {"name": "id", "@column": COL_ID}},
                        {
                            "field.string": {
                                "name": "email",
                                "@column": COL_EMAIL,
                                "@required": True,
                            }
                        },
                        {
                            "field.object": {
                                "name": "profile",
                                "@column": JSONB_COL,
                                "@objectRef": "Address",
                                "@storage": "jsonb",
                            }
                        },
                        {
                            "identity.primary": {
                                "name": "pk",
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            {
                "object.projection": {
                    "name": "CustomerSummary",
                    "children": [
                        {"source.rdb": {"@kind": "view", "@view": VIEW}},
                        {"field.long": {"name": "id", "extends": "Customer.id"}},
                        {
                            "field.string": {
                                "name": "email",
                                "children": [
                                    {"origin.passthrough": {"@from": "Customer.email"}}
                                ],
                            }
                        },
                        {"identity.primary": {"name": "pk", "extends": "Customer.pk"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Order",
                    "children": [
                        {"source.rdb": {"@table": ORDER_TABLE}},
                        {"field.long": {"name": "id", "@column": ORDER_ID}},
                        {"field.long": {"name": "customerId", "@column": COL_FK}},
                        {
                            "identity.primary": {
                                "name": "pk",
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                        {
                            "identity.reference": {
                                "name": "customerRef",
                                "@fields": "customerId",
                                "@references": "Customer",
                            }
                        },
                        {
                            "relationship.association": {
                                "name": "customer",
                                "@cardinality": "one",
                                "@objectRef": "Customer",
                            }
                        },
                    ],
                }
            },
        ],
    }
}


def _is_names_module(path: str) -> bool:
    """The names module is the ONE file allowed to spell a physical name literally."""
    return path.endswith("_names.py")


def _generate(tmp_path: Path) -> dict[str, str]:
    """Run every NATIVE generator the registry knows — a hand-picked subset is how a
    generator escapes the gate — and return every emitted file."""
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(
            json.dumps(MODEL), format=MetaDataFormat.JSON, id="no-magic.json"
        ),
    ])
    # A gate whose fixture the loader would reject proves nothing.
    assert [str(e) for e in result.errors] == []
    root = result.root

    out = tmp_path / "gen"
    generators = [e.factory() for e in list_generators() if e.tier == "native"]
    run_gen(
        GenConfig(out_dir=str(out), column_naming="snake_case"),
        root,
        generators=generators,
    )
    return {
        str(p.relative_to(out)): p.read_text()
        for p in out.rglob("*")
        if p.is_file()
    }


def test_emits_a_names_module_carrying_every_de_blinded_physical_name(tmp_path: Path) -> None:
    tree = _generate(tmp_path)
    names = {p: c for p, c in tree.items() if _is_names_module(p)}
    # Teeth: with no names module at all every assertion below passes vacuously.
    assert names, "no *_names.py emitted — every assertion below would be vacuous"
    body = "\n".join(names.values())
    missing = sorted(
        f"{t.literal} appears in no names module — {t.should_use} cannot exist"
        for t in TOKENS
        if t.reach is Reach.CONSTANT and t.literal not in body
    )
    assert missing == []


def test_no_generated_file_outside_the_names_module_spells_a_physical_name(
    tmp_path: Path,
) -> None:
    """The claim this gate exists for, and the one Python passes on its own terms."""
    tree = _generate(tmp_path)
    offenders = sorted(
        f'{path}: hard-codes "{t.literal}" — should reference {t.should_use}'
        for path, content in tree.items()
        if not _is_names_module(path)
        for t in TOKENS
        if t.reach is Reach.CONSTANT and t.literal in content
    )
    # Reported as a sorted list rather than a boolean, so a failure enumerates every
    # remaining gap in one run instead of one per fix-and-rerun cycle.
    assert offenders == []


def test_the_run_emits_real_output_so_the_clean_result_above_is_not_vacuous(
    tmp_path: Path,
) -> None:
    """The teeth for the test above, adapted to this port.

    Elsewhere the anti-vacuity assertion is "every constant is REFERENCED by some
    generated file" — because there, generated code binds an ORM (Drizzle, EF Core,
    Exposed) and must therefore spell a physical name. Python's generated surface is
    Pydantic models + FastAPI routers over a consumer-implemented repository Protocol:
    the physical layer is the adopter's, so there is no generated consumer, and
    demanding one would mean inventing output nobody asked for.

    What must still be ruled out is the OTHER way a "no literals" result comes out
    clean: emitting nothing. So this asserts the run produced substantive per-entity
    output for every object in the fixture, alongside the names modules. If Python ever
    grows a generator that does bind physical storage, the gate above starts convicting
    it the day it lands.
    """
    tree = _generate(tmp_path)
    non_names = {p for p in tree if not _is_names_module(p)}
    for module in ("Customer.py", "Order.py", "CustomerSummary.py"):
        assert module in non_names, sorted(non_names)
    # ...and the names modules exist for exactly the three table/view-backed objects
    # (Address is an object.value — no source, so no module, per #248).
    assert sorted(p for p in tree if _is_names_module(p)) == [
        "customer_names.py",
        "customer_summary_names.py",
        "order_names.py",
    ]


def test_every_physical_name_that_escapes_is_a_declared_known_literal(
    tmp_path: Path,
) -> None:
    """The exhaustive form, and the strongest statement this gate can make.

    The token list above says what each KNOWN name should do. This says there is
    nothing ELSE: every physical name in the fixture is `zz_phys_`-prefixed, so any such
    token appearing outside a names module is a physical name that escaped, whether or
    not anyone thought to list it. Equality (not containment) in both directions — a new
    escape fails, and so does a KNOWN_LITERAL that has quietly been fixed, which is how a
    "known gaps" list ends up describing a codebase that moved on.

    For Python the expected set is EMPTY, and that is the finding: this port's generated
    code contains no physical database name anywhere. Not a gap to close — the physical
    layer is the adopter's repository implementation, and the names modules exist to be
    referenced BY it.
    """
    tree = _generate(tmp_path)
    escaped = {
        token
        for path, content in tree.items()
        if not _is_names_module(path)
        for token in re.findall(r"zz_phys_\w+", content)
    }
    expected = {t.literal for t in TOKENS if t.reach is Reach.KNOWN_LITERAL}
    assert escaped == expected
