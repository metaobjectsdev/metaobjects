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

WHAT THE FIXTURE MUST CONTAIN is the other half, and the half that failed first. This
gate ran green for its whole life over a fixture with no TPH pair, no ``field.enum``, no
``identity.secondary``, no ``index.lookup``, no callable source, no ``@schema``, no
``isArray`` and no abstract base. Every one of those shapes is handled on its own code
path, so the green meant "the paths we happened to model are clean", which is a much
smaller claim than the one the gate's name makes. Widening the TypeScript fixture found
four escapes and one silently-dropped name on the first run. A gate is only ever as wide
as its fixture, so treat the model below as the load-bearing part of this file and add
to it whenever a generator grows a new path.

Python's answer differs from the other ports' and the difference is the POINT of
running the gate here rather than reasoning about it: see
``test_no_generated_file_outside_the_names_module_spells_a_physical_name`` and
``test_no_generated_consumer_imports_a_names_module``. Widening the fixture did NOT
change that answer — every added shape, the M:N pair included, lands its names in a
names module and nowhere else — but "did not change" is now a measurement over those
paths rather than a guess about them.

ONE category is out of this method's reach in the ports that DO bind an ORM, and it is
worth naming rather than leaving a reader to assume otherwise: a RELATIONSHIP-SYNTHESIZED
foreign-key column — the column a parent-side ``relationship.composition @cardinality:
many`` contributes to the child's table when the child declares no field for it. That name
is DERIVED (the relationship's short name + "Id", through the naming strategy), never
declared, so there is no physical name to de-blind and nothing for a generator to restate.
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
    """How a physical name reaches generated output today.

    Every non-``CONSTANT`` value is PINNED, not exempted: the gate asserts the literal
    is still there (or, for ``DROPPED``, still unread), so the day a generator starts
    referencing a constant instead, the pin fails and says "promote it".

    ``KNOWN_LITERAL`` and ``ESCAPE`` are kept APART because they are not the same claim,
    and collapsing them is how a defect acquires the standing of a ruling. ``DROPPED``
    is the failure mode the two-literal form of this gate was BLIND to: an escape spells
    a name twice, a dropped name is spelled ZERO times, so every "does a file contain
    this literal" assertion passes for it.

    Python's answer today is that BOTH the ``ESCAPE`` and the ``DROPPED`` sets are
    empty, and for one structural reason: this port's generated surface (Pydantic models,
    FastAPI routers, filter allowlists) contains no database binding at all, so there is
    no generated consumer that could restate a name OR silently take a default in place
    of one. ``test_no_generated_consumer_imports_a_names_module`` pins that reason, so
    the empty sets are a checked fact rather than an assumption — the day a generator
    here does bind storage, that pin fails and every row below is up for re-classification.
    """

    #: Travels as a ``<ENTITY>_*`` names-module constant; appears literally nowhere else.
    CONSTANT = "constant"
    #: STRUCTURAL: still spelled literally, and no constant exists for it — none should
    #: be expected. Pinned, not exempted.
    KNOWN_LITERAL = "known_literal"
    #: A DEFECT: the constant exists, in an artifact this same run emits, and a generator
    #: spelled the name again anyway. Every ESCAPE row's constant must be REACHABLE
    #: (``test_every_escape_row_names_a_reachable_constant``), so no row can sit here
    #: claiming a fix is impossible when it is merely undone.
    ESCAPE = "escape"
    #: The artifact carries the name and NO generator reads it, so the binding silently
    #: takes a default. Spelled zero times, so every "does a file contain this literal"
    #: assertion passes for it; pinned as carried-but-unread by
    #: ``test_each_dropped_row_is_carried_but_unread`` so wiring it up fails the row.
    DROPPED = "dropped"


@dataclass(frozen=True)
class Token:
    literal: str
    should_use: str
    reach: Reach = Reach.CONSTANT
    why: str = ""


# ---------------------------------------------------------------------------
# The de-blinded fixture, kept in step with the other ports' gates so a reader can
# diff the coverage directly. Every physical name is `zz_phys_*` and deliberately
# UNRELATED to the logical name it belongs to, so no derivation can produce it.
# ---------------------------------------------------------------------------
TABLE = "zz_phys_tbl_alpha"        # NOT pluralize(snake("Customer"))
COL_ID = "zz_phys_col_ident"       # NOT snake("id")
COL_EMAIL = "zz_phys_col_mail"     # NOT snake("email")
COL_FK = "zz_phys_col_owner"       # NOT snake("customerId")
ORDER_TABLE = "zz_phys_tbl_beta"   # NOT pluralize(snake("Order"))
ORDER_ID = "zz_phys_col_okey"
VIEW = "zz_phys_view_gamma"        # NOT "v_" + snake("CustomerSummary")
VO_COL = "zz_phys_col_street"
JSONB_COL = "zz_phys_col_blob"     # a single-jsonb-column value object
VO_MEMBER_COL = "zz_phys_col_road" # a member column INSIDE that value object
WT_TABLE = "zz_phys_tbl_delta"     # a write-through entity's table...
WT_VIEW = "zz_phys_view_delta"     # ...and its replica view
WT_ID = "zz_phys_col_acct"         # the write-through entity's key column

# --- Shapes the original fixture did not contain -----------------------------------
# Each block below exists because a generator handles it on a DIFFERENT code path from
# the plain-entity one above, and a path no fixture reaches is a path this gate cannot
# speak for.
WIDGET_TABLE = "zz_phys_tbl_wid"   # the index/enum/schema entity's table
TPH_TABLE = "zz_phys_tbl_veh"      # a TPH discriminator base's table
TPH_ID = "zz_phys_col_vid"
TPH_DISC = "zz_phys_col_kind"      # the discriminator column
TPH_SUB_COL = "zz_phys_col_doors"  # a SUBTYPE's own column, folded into the base table
SCHEMA = "zz_phys_sch_one"         # @schema on a source.rdb
ENUM_COL = "zz_phys_col_stat"      # a string-backed field.enum
ENUM_INT_COL = "zz_phys_col_grad"  # an int-backed field.enum (@intValueMap)
ARRAY_COL = "zz_phys_col_tags"     # an isArray field
ALT_COL = "zz_phys_col_alt"        # the column an identity.secondary keys on
SEC_INDEX = "zz_phys_idx_sec"      # an identity.secondary's own name
LKP_INDEX = "zz_phys_idx_lkp"      # an index.lookup's own name
ABS_COL = "zz_phys_col_bid"        # a column declared on an ABSTRACT base
PROC = "zz_phys_proc_alpha"        # a storedProc source's physical name
PROC_ARG_COL = "zz_phys_col_since"
PROC_OUT_COL = "zz_phys_col_total"

# --- Beyond the cross-port shape list: the M:N pair -----------------------------------
# Not one of the shapes `scripts/check-no-magic-gate-coverage.sh` tracks, and modelled
# here on purpose: `m2m_codegen.resolve_m2m_descriptors` is the ONE Python code path that
# resolves physical table AND column names at emit time (junction table, junction FK
# columns, target table, target PK column) and hands them to the router generator, which
# — by its own docstring — reads none of them today. That is the most likely FUTURE escape
# in this port: the literals are already in the emitter's hand, one `f"{d.junction_table}"`
# away from output. A fixture without an M:N pair could never see it happen.
TAG_TABLE = "zz_phys_tbl_tag"        # NOT pluralize(snake("Tag"))
TAG_ID = "zz_phys_col_tkey"
JUNCTION_TABLE = "zz_phys_tbl_ot"    # NOT pluralize(snake("OrderTag"))
JUNCTION_ORDER_COL = "zz_phys_col_jord"  # NOT snake("orderId")
JUNCTION_TAG_COL = "zz_phys_col_jtag"    # NOT snake("tagId")

# Every `should_use` below is the constant the Python names module ACTUALLY defines —
# `<ENTITY.upper()>_<MEMBER>_COLUMN` / `<ENTITY.upper()>_NAME` / `..._SCHEMA`, with NO
# snake step on the entity name (`CustomerSummary` -> `CUSTOMERSUMMARY_NAME`, not the
# TS/C# `CustomerSummaryNames` spelling). `test_every_should_use_is_a_constant_the_names_
# modules_actually_define` holds each one to the emitted text; the previous fixture's
# `CUSTOMER_SUMMARY_NAME` matched no artifact and nothing could tell.
TOKENS: tuple[Token, ...] = (
    Token(TABLE, "CUSTOMER_NAME"),
    Token(COL_ID, "CUSTOMER_ID_COLUMN"),
    Token(COL_EMAIL, "CUSTOMER_EMAIL_COLUMN"),
    Token(VO_COL, "CUSTOMER_STREET_COLUMN"),
    Token(JSONB_COL, "CUSTOMER_PROFILE_COLUMN"),
    Token(ORDER_TABLE, "ORDER_NAME"),
    Token(ORDER_ID, "ORDER_ID_COLUMN"),
    Token(COL_FK, "ORDER_CUSTOMER_ID_COLUMN"),
    Token(VIEW, "CUSTOMERSUMMARY_NAME"),
    Token(WT_TABLE, "ACCOUNT_NAME"),
    Token(WT_ID, "ACCOUNT_ID_COLUMN"),

    # --- TPH: a discriminator base folds its subtypes' own columns into one table ------
    # The subtype's module re-exports the base's source constants BY REFERENCE
    # (`CAR_NAME = VEHICLE_NAME`) and declares only its own column. So the literal for
    # the shared table lives in `vehicle_names.py` and the subtype's own column in
    # `car_names.py` — which is where each `should_use` points.
    Token(TPH_TABLE, "VEHICLE_NAME"),
    Token(TPH_ID, "VEHICLE_ID_COLUMN"),
    Token(TPH_DISC, "VEHICLE_KIND_COLUMN"),
    Token(
        TPH_SUB_COL, "CAR_DOORS_COLUMN",
        why=(
            "In the TS drizzle fold this is an ESCAPE (the subtype's columns are "
            "resolved against the BASE's names ref and fall back to the literal). "
            "Python's TPH router and entity model emit field NAMES, never columns, so "
            "the subtype column reaches output only through its own names module."
        ),
    ),

    # --- the enum / index / schema entity ---------------------------------------------
    Token(WIDGET_TABLE, "WIDGET_NAME"),
    Token(
        ENUM_COL, "WIDGET_STATUS_COLUMN",
        why=(
            "An ESCAPE in TS, where the enum CHECK constraint's expression body spells "
            "the column. Python emits no DDL and no CHECK, so there is no second site."
        ),
    ),
    Token(
        ENUM_INT_COL, "WIDGET_GRADE_COLUMN",
        why="As ENUM_COL — the @intValueMap arm emits a Literal[...] of SYMBOLS, no column.",
    ),
    Token(ARRAY_COL, "WIDGET_TAGS_COLUMN"),
    Token(ALT_COL, "WIDGET_ALT_COLUMN"),
    Token(
        ABS_COL, "ABSTRACTKEYED_ID_COLUMN",
        why=(
            "Declared on an ABSTRACT base, so the literal lives in the base's FRAGMENT "
            "module (`abstract_keyed_names.py`, no physical name of its own) and the "
            "concrete Widget re-exports it by reference as WIDGET_ID_COLUMN. One "
            "spelling, reached through the resolving accessor (ADR-0039)."
        ),
    ),
    Token(
        SCHEMA, "WIDGET_SCHEMA",
        why=(
            "In every ORM-binding port this row is DROPPED: the artifact carries "
            "@schema and no table binding reads it, so the table lands in the default "
            "schema. Python has no generated table binding for a schema to be dropped "
            "FROM — the constant is carried, unread like every other constant here, and "
            "the adopter's repository is the consumer. CONSTANT on this port's terms; "
            "`test_no_generated_consumer_imports_a_names_module` is what keeps those "
            "terms honest."
        ),
    ),

    # --- the callable (stored procedure) ----------------------------------------------
    Token(
        PROC, "PROCOUT_NAME",
        why=(
            "An ESCAPE in TS, whose callableFile spells the proc name into emitted SQL. "
            "Python has NO callable generator in its registry at all — the storedProc "
            "projection reaches the names generator and the entity model and nothing "
            "else — so there is no emitter on this port to restate the name. That the "
            "FR-015 callable path is simply unimplemented here is a finding this gate "
            "records rather than one it can fail on."
        ),
    ),
    Token(PROC_OUT_COL, "PROCOUT_TOTAL_COLUMN"),

    # --- M:N: junction + target physical names the router has IN HAND -----------------
    Token(TAG_TABLE, "TAG_NAME"),
    Token(TAG_ID, "TAG_ID_COLUMN"),
    Token(JUNCTION_TABLE, "ORDERTAG_NAME"),
    Token(JUNCTION_ORDER_COL, "ORDERTAG_ORDER_ID_COLUMN"),
    Token(JUNCTION_TAG_COL, "ORDERTAG_TAG_ID_COLUMN"),
    # No KNOWN_LITERAL, ESCAPE or DROPPED row: this port emits no physical name outside its
    # names modules AT ALL. Both the escape set and the dropped set are asserted EMPTY
    # below, and the reason they are empty is pinned as a fact of the generated tree
    # rather than left as a sentence in this comment.
)

# Physical names the model DECLARES and no generated file spells — not even a names
# module. They carry no TOKENS row because the artifact has no slot for them, and none of
# the four Reach values describes "absent everywhere". They are still declared so the
# exhaustive test convicts a generator that starts spelling one, and each is PINNED as
# absent by `test_uncarried_names_are_spelled_nowhere`, so that the day the artifact grows
# a slot (an index name, the replica view, a value member) the pin fails and says "give it
# a row" instead of the new carrying passing unnoticed.
UNCARRIED: tuple[Token, ...] = (
    Token(
        VO_MEMBER_COL, "(no constant exists)",
        why=(
            "A value object has no source and so no names module; its member column is "
            "the ORM ports' one KNOWN_LITERAL. Python does not spell it anywhere — in the "
            "fixture precisely so that claim is tested rather than assumed."
        ),
    ),
    Token(
        WT_VIEW, "(no constant exists)",
        why=(
            "A write-through entity has TWO physical names; the names module carries the "
            "PRIMARY source's only. The replica view has no slot, and the Python router "
            "routes reads to it inside the ObjectManager, never in generated text."
        ),
    ),
    Token(
        SEC_INDEX, "(no constant exists)",
        why=(
            "An index's database name IS its metamodel `name` — nothing to restate, and "
            "the names module carries no index slot. TS pins this as KNOWN_LITERAL because "
            "drizzle emits it; Python emits no index DDL, so it is spelled zero times."
        ),
    ),
    Token(LKP_INDEX, "(no constant exists)", why="As SEC_INDEX — an index.lookup's name."),
    Token(
        PROC_ARG_COL, "(no constant exists)",
        why=(
            "A @parameterRef value object has no source and so no names module, and a "
            "callable binds its arguments POSITIONALLY — the column name is never emitted."
        ),
    ),
)

MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                # A value object: no source, so no names module — its members reach output
                # only through the owning entity's column.
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
                        {"field.string": {"name": "street", "@column": VO_COL}},
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
                # A projection: its physical name comes from the view resolver, a
                # DIFFERENT resolver than the table path.
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
                        {
                            # M:N through OrderTag — the junction's two identity.reference
                            # children are the FK SSOT; the relationship restates nothing.
                            "relationship.association": {
                                "name": "tags",
                                "@cardinality": "many",
                                "@objectRef": "Tag",
                                "@through": "OrderTag",
                            }
                        },
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Tag",
                    "children": [
                        {"source.rdb": {"@table": TAG_TABLE}},
                        {"field.long": {"name": "id", "@column": TAG_ID}},
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
                "object.entity": {
                    "name": "OrderTag",
                    "children": [
                        {"source.rdb": {"@table": JUNCTION_TABLE}},
                        {"field.long": {"name": "orderId", "@column": JUNCTION_ORDER_COL}},
                        {"field.long": {"name": "tagId", "@column": JUNCTION_TAG_COL}},
                        {"identity.primary": {"name": "pk", "@fields": ["orderId", "tagId"]}},
                        {
                            "identity.reference": {
                                "name": "orderRef",
                                "@fields": "orderId",
                                "@references": "Order",
                            }
                        },
                        {
                            "identity.reference": {
                                "name": "tagRef",
                                "@fields": "tagId",
                                "@references": "Tag",
                            }
                        },
                    ],
                }
            },
            {
                # An ABSTRACT base carrying a field. Its column reaches output only through
                # the concrete entity that extends it, on the resolving-accessor path
                # (ADR-0039) — a different lookup from a field declared in place.
                "object.entity": {
                    "name": "AbstractKeyed",
                    "abstract": True,
                    "children": [{"field.long": {"name": "id", "@column": ABS_COL}}],
                }
            },
            {
                # TPH. The base's table absorbs every concrete subtype's own columns, so
                # this is the one shape where a generator emits a column belonging to a
                # DIFFERENT entity than the one whose names module it has in hand.
                "object.entity": {
                    "name": "Vehicle",
                    "@discriminator": "kind",
                    "children": [
                        {"source.rdb": {"@table": TPH_TABLE}},
                        {"field.long": {"name": "id", "@column": TPH_ID}},
                        {"field.string": {"name": "kind", "@column": TPH_DISC}},
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
                "object.entity": {
                    "name": "Car",
                    "extends": "Vehicle",
                    "@discriminatorValue": "Car",
                    "children": [{"field.int": {"name": "doors", "@column": TPH_SUB_COL}}],
                }
            },
            {
                # @schema, both field.enum arms (string- and int-backed), an isArray column,
                # an identity.secondary and an index.lookup — five paths the original
                # fixture reached none of.
                "object.entity": {
                    "name": "Widget",
                    "extends": "AbstractKeyed",
                    "children": [
                        {"source.rdb": {"@table": WIDGET_TABLE, "@schema": SCHEMA}},
                        {
                            "field.enum": {
                                "name": "status",
                                "@column": ENUM_COL,
                                "@values": ["OPEN", "SHUT"],
                            }
                        },
                        {
                            "field.enum": {
                                "name": "grade",
                                "@column": ENUM_INT_COL,
                                "@values": ["LO", "HI"],
                                "@intValueMap": {"LO": 1, "HI": 2},
                            }
                        },
                        {"field.string": {"name": "tags", "isArray": True, "@column": ARRAY_COL}},
                        {"field.string": {"name": "alt", "@column": ALT_COL}},
                        {
                            "identity.primary": {
                                "name": "pk",
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                        {"identity.secondary": {"name": SEC_INDEX, "@fields": ["alt"]}},
                        {"index.lookup": {"name": LKP_INDEX, "@fields": ["status"]}},
                    ],
                }
            },
            {
                # FR-015 — a stored-procedure projection and its @parameterRef value
                # object. In TS this reaches `callableFile()`, a THIRD physical-name
                # resolver; Python's registry has no callable generator, so the shape
                # measures the names + entity generators' storedProc arms and records
                # that nothing else on this port reaches it.
                "object.value": {
                    "name": "ProcArgs",
                    "children": [{"field.long": {"name": "since", "@column": PROC_ARG_COL}}],
                }
            },
            {
                "object.projection": {
                    "name": "ProcOut",
                    "children": [
                        {
                            "source.rdb": {
                                "@kind": "storedProc",
                                "@proc": PROC,
                                "@parameterRef": "ProcArgs",
                            }
                        },
                        {"field.long": {"name": "total", "@column": PROC_OUT_COL}},
                    ],
                }
            },
            {
                # Write-through: writes go to the table, reads to the replica view — TWO
                # physical names on one object, only one of which the names module holds.
                "object.entity": {
                    "name": "Account",
                    "children": [
                        {"source.rdb": {"@table": WT_TABLE, "@role": "primary"}},
                        {"source.rdb": {"@kind": "view", "@view": WT_VIEW, "@role": "replica"}},
                        {"field.long": {"name": "id", "@column": WT_ID}},
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


def _names_body(tree: dict[str, str]) -> str:
    return "\n".join(c for p, c in tree.items() if _is_names_module(p))


def _consumer_body(tree: dict[str, str]) -> str:
    return "\n".join(c for p, c in tree.items() if not _is_names_module(p))


def test_emits_a_names_module_carrying_every_de_blinded_physical_name(tmp_path: Path) -> None:
    tree = _generate(tmp_path)
    names = {p: c for p, c in tree.items() if _is_names_module(p)}
    # Teeth: with no names module at all every assertion below passes vacuously.
    assert names, "no *_names.py emitted — every assertion below would be vacuous"
    body = "\n".join(names.values())
    missing = sorted(
        f"{t.literal} appears in no names module — {t.should_use} cannot exist"
        for t in TOKENS
        # A KNOWN_LITERAL has no constant by definition; every other reach claims one.
        if t.reach is not Reach.KNOWN_LITERAL and t.literal not in body
    )
    assert missing == []


def test_every_should_use_is_a_constant_the_names_modules_actually_define(
    tmp_path: Path,
) -> None:
    """Each `should_use` is held to the EMITTED text, not to a spelling copied from
    another port's gate.

    The ORM ports prove a `should_use` exists by finding it REFERENCED in some generated
    consumer. Python has no generated consumer, so nothing here ever read the field — and
    the previous fixture carried `CUSTOMER_SUMMARY_NAME` for a projection whose module
    defines `CUSTOMERSUMMARY_NAME`, for its whole life, with no test able to tell. A row
    whose `should_use` names nothing is a row that cannot be acted on, which is the same
    comfortable state an unreachable ESCAPE would sit in. So: the exact declaration line,
    with the literal on it.
    """
    tree = _generate(tmp_path)
    body = _names_body(tree)
    undefined = sorted(
        f'{t.should_use}: Final[str] = "{t.literal}" is defined in no names module'
        for t in TOKENS
        if t.reach is not Reach.KNOWN_LITERAL
        and f'{t.should_use}: Final[str] = "{t.literal}"' not in body
    )
    assert undefined == []


def test_no_generated_file_outside_the_names_module_spells_a_physical_name(
    tmp_path: Path,
) -> None:
    """The claim this gate exists for, and the one Python passes on its own terms."""
    tree = _generate(tmp_path)
    # A declared escape can CONTAIN a constant's literal as a substring (a composite
    # CHECK-constraint name wraps a table and a column), so mask the declared literals
    # first — longest first, so a composite is dismantled before its parts — and each
    # defect is reported against exactly one row. Empty on this port today; kept so the
    # day a row appears the offenders list stays one-report-per-defect.
    declared = sorted(
        (t.literal for t in TOKENS if t.reach in (Reach.ESCAPE, Reach.KNOWN_LITERAL)),
        key=len,
        reverse=True,
    )

    def masked(content: str) -> str:
        for lit in declared:
            content = content.replace(lit, "")
        return content

    offenders = sorted(
        f'{path}: hard-codes "{t.literal}" — should reference {t.should_use}'
        for path, content in tree.items()
        if not _is_names_module(path)
        for t in TOKENS
        if t.reach is Reach.CONSTANT and t.literal in masked(content)
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
    output — an entity module for every sourced object AND a router for every
    writable-table entity, the tier where an escape would most plausibly land — alongside
    exactly the names modules the fixture should produce. If Python ever grows a
    generator that does bind physical storage, the gate above starts convicting it the
    day it lands.
    """
    tree = _generate(tmp_path)
    non_names = {p for p in tree if not _is_names_module(p)}
    for module in (
        "Customer.py", "Order.py", "CustomerSummary.py", "Tag.py", "OrderTag.py",
        "Vehicle.py", "Car.py", "Widget.py", "ProcOut.py", "Account.py",
    ):
        assert module in non_names, sorted(non_names)
    # Every writable-table entity gets a router; a TPH subtype's CRUD lives under its
    # base's per-subtype segment (so no car_router.py), and a projection gets none.
    for router in (
        "customer_router.py", "order_router.py", "tag_router.py", "order_tag_router.py",
        "vehicle_router.py", "widget_router.py", "account_router.py",
    ):
        assert router in non_names, sorted(non_names)
    # ...and the names modules exist for exactly the sourced objects plus the ONE abstract
    # fragment a sourced object extends (Address and ProcArgs are object.values — no
    # source, so no module, per #248).
    assert sorted(p for p in tree if _is_names_module(p)) == [
        "abstract_keyed_names.py",
        "account_names.py",
        "car_names.py",
        "customer_names.py",
        "customer_summary_names.py",
        "order_names.py",
        "order_tag_names.py",
        "proc_out_names.py",
        "tag_names.py",
        "vehicle_names.py",
        "widget_names.py",
    ]


def test_no_generated_consumer_imports_a_names_module(tmp_path: Path) -> None:
    """The structural fact that makes Python's empty ESCAPE and DROPPED sets a ruling
    rather than an accident of what the fixture happened to reach.

    The reference test the ORM ports run — "every constant is REFERENCED by some
    generated file" — has an exact inverse here: NO generated file references ANY
    constant a names module defines, and none imports a names module. That is what it
    means for the physical layer to be the adopter's. It is asserted rather than stated
    because it is the premise of every other claim in this file: the moment a generator
    here does read a names constant, Python has a consumer, the empty sets stop being
    structural, and every row above is up for re-classification — this fails first and
    says so, instead of the reference silently making the gate's terms wrong.

    The set of constant names is taken FROM the emitted modules, not hand-listed, so a
    new constant kind (an index slot, a replica-view slot) is covered the day it appears.
    """
    tree = _generate(tmp_path)
    defined = sorted(
        {
            m.group(1)
            for c in (c for p, c in tree.items() if _is_names_module(p))
            for m in re.finditer(r"^([A-Z][A-Z0-9_]*): Final\[", c, flags=re.MULTILINE)
        }
    )
    assert defined, "no constants found in any names module — the check below is vacuous"
    constant = re.compile(r"\b(" + "|".join(map(re.escape, defined)) + r")\b")
    consumers = sorted(
        f"{path}: {kind} {hit}"
        for path, content in tree.items()
        if not _is_names_module(path)
        for kind, hit in (
            *(("references", m.group(1)) for m in constant.finditer(content)),
            *(("imports", m.group(0)) for m in re.finditer(r"from \.\w+_names import", content)),
        )
    )
    assert consumers == []


def test_every_physical_name_that_escapes_is_a_declared_known_literal(
    tmp_path: Path,
) -> None:
    """The exhaustive form, and the strongest statement this gate can make.

    The token list above says what each KNOWN name should do. This says there is
    nothing ELSE: every physical name in the fixture is `zz_phys_`-prefixed, so any such
    token appearing outside a names module is a physical name that escaped, whether or
    not anyone thought to list it. Equality (not containment) in both directions — a new
    escape fails, and so does a KNOWN_LITERAL or ESCAPE that has quietly been fixed,
    which is how a "known gaps" list ends up describing a codebase that moved on.

    For Python the expected set is EMPTY, and that is the finding: this port's generated
    code contains no physical database name anywhere — across a plain entity, a value
    object, a projection, a write-through pair, an abstract base, a TPH pair, both enum
    backings, an array column, both index kinds, @schema, a stored procedure and an M:N
    junction. Not a gap to close — the physical layer is the adopter's repository
    implementation, and the names modules exist to be referenced BY it.
    """
    tree = _generate(tmp_path)
    escaped = {
        token
        for path, content in tree.items()
        if not _is_names_module(path)
        for token in re.findall(r"zz_phys_\w+", content)
    }
    expected = {t.literal for t in TOKENS if t.reach in (Reach.KNOWN_LITERAL, Reach.ESCAPE)}
    assert escaped == expected


def test_every_escape_row_names_a_reachable_constant(tmp_path: Path) -> None:
    """Proves every ESCAPE is a defect and not a structural impossibility.

    The row type lets an author write ESCAPE with a `should_use` naming a constant that
    does not exist — which would read as "we know about it" while being unfixable, the
    most comfortable possible state for a defect to sit in. So: for every escape, the
    constant it should have used must be REACHABLE — its owning names module emitted, by
    this same run, carrying the literal. That turns each row into a claim that can be
    acted on today, and it is what separates these rows from KNOWN_LITERAL ones.

    Vacuous over Python's empty escape set today, and deliberately so: the shape is here
    for the first real row, and `test_no_generated_consumer_imports_a_names_module` is
    what says the set is empty for a reason rather than by omission.
    """
    tree = _generate(tmp_path)
    body = _names_body(tree)
    unreachable = sorted(
        f"{t.literal} is marked an escape but {t.should_use} is in no names module"
        for t in TOKENS
        if t.reach is Reach.ESCAPE and t.literal not in body
    )
    assert unreachable == []


def test_each_dropped_row_is_carried_but_unread(tmp_path: Path) -> None:
    """Pins each DROPPED name as carried-but-unread, so wiring it up fails this row.

    The counterpart to the ORM ports' reference test, for the failure mode that test
    cannot state. A DROPPED row asserts BOTH halves of its own claim: a names module
    carries the name (so a consumer could read it) and no generated file references the
    constant (so none does). Asserting the second half is the point — it is a pin on a
    DEFECT, and the day a generator starts honouring the name this row fails and demands
    promotion to CONSTANT, rather than the fix landing with nothing to notice it.

    Vacuous over Python's empty dropped set today, for the same structural reason as the
    escape set: there is no generated binding for a name to be dropped FROM. `@schema`,
    DROPPED in every ORM port, is CONSTANT here (see its row). Be clear about what that
    means: on this port a DROPPED row and a CONSTANT row are OBSERVATIONALLY IDENTICAL —
    every constant is carried-but-unread, so marking SCHEMA `DROPPED` passes every test
    in this file. The classification is carried by the ruling that this port has no
    binding, not by this test; `test_no_generated_consumer_imports_a_names_module` is
    the check on that ruling, and it fails first if a binding generator lands — at which
    point the SCHEMA row is the first candidate for this reach.
    """
    tree = _generate(tmp_path)
    names = _names_body(tree)
    body = _consumer_body(tree)
    wrong = sorted(
        msg
        for t in TOKENS
        if t.reach is Reach.DROPPED
        for msg in (
            *([] if t.literal in names
              else [f"{t.literal} is marked dropped but no names module carries it"]),
            *([f'{t.should_use} IS referenced now — promote "{t.literal}" to Reach.CONSTANT']
              if t.should_use in body else []),
        )
    )
    assert wrong == []


def test_uncarried_names_are_spelled_nowhere(tmp_path: Path) -> None:
    """Pins each UNCARRIED name as absent from the WHOLE tree, names modules included.

    These names have no TOKENS row because no Reach value describes them: the artifact
    has no slot for an index name, a replica view or a value member, so they are not
    CONSTANT; nothing spells them, so they are not KNOWN_LITERAL or ESCAPE; and the
    artifact does not carry them, so they are not DROPPED. Absence is still a claim, and
    an unpinned claim is how the artifact could grow a slot for one of these — the index
    slot the TS gate's KNOWN_LITERAL rows anticipate, say — with this file still
    describing it as unspelled. When that happens this fails and says "give it a row".
    """
    tree = _generate(tmp_path)
    everything = "\n".join(tree.values())
    spelled = sorted(
        f'{t.literal} is now spelled by some generated file — give it a TOKENS row'
        for t in UNCARRIED
        if t.literal in everything
    )
    assert spelled == []
