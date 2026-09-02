"""Every ``GenConfig`` field must be able to affect something, or say why not.

A config field nothing reads is the worst kind of defect this project ships: setting it
runs clean, reports success and changes nothing, so the author believes they configured
something and the tool never disagrees. ``GenConfig.column_naming`` was exactly that
through ``0.24.5`` — zero readers anywhere in ``src/``, while ``docs/features/field-types.md``
named it as this port's codegen lever. It was found by an adopter, not by a test, because
no test set it and asserted an output.

The suite could not have caught it. ``test_column_naming_strategy.py`` gated the pure
``apply_column_naming_strategy`` function in isolation — correct, and silent about whether
anything CALLS it — and ``test_m2m_codegen.py``'s descriptor assertions all ran at the
``literal`` default, where a junction column name EQUALS its field name, so they passed
identically whether the strategy was applied or ignored. Parts tested, connection not.

This gate asks the one question none of those asked: **is this field read by anything?**
It is a static read-check, deliberately: a behavioural version (set a non-default value,
assert the emitted bytes change) is stronger and is the right follow-on, but it needs a
value domain and a fixture per field, and a field with NO readers cannot be behaviourally
tested at all — it has to be caught here first.

A field's own validator does not count as a read. That exclusion is the whole point: a
field can be made honest by REFUSING a value it cannot honour, and a naive read-check
would then be satisfied by the refusal itself and stop looking.
"""
from __future__ import annotations

import dataclasses
import re
from pathlib import Path

from metaobjects.codegen.config import GenConfig

SRC = Path(__file__).parents[2] / "src" / "metaobjects"
#: The field's own module — a read here is either the declaration or its validator.
DECLARING_MODULE = SRC / "codegen" / "config.py"

# A field that cannot affect output, and the decision that makes that acceptable. An entry
# is a claim on the record; a missing reader is an accident. Same shape as the view-renderer
# gate's NO_RENDERER_BY_DESIGN in codegen-ts-tanstack.
INERT_BY_DESIGN: dict[str, str] = {
    "output_layout": (
        "only 'flat' is implemented in this port, which is what the field's own comment "
        "always said. REFUSED at construction for any other value, so the stub cannot be "
        "mistaken for a working knob — a default-value test in test_constants_config.py "
        "pinned it and made it look covered."
    ),
    "emit_abstract_shapes": (
        "this port ALWAYS emits the abstract base model (concretes subclass it) and "
        "suppressing it is not implemented here. It is a REAL knob in C# (`dotnet meta gen "
        "--emit-abstract-shapes`), which is what made an unimplemented option look like a "
        "shared one, and instance_artifacts.py's docstring claimed entity_model handled it. "
        "REFUSED at construction; the exemption goes when this port implements suppression."
    ),
}


def _reads_of(field_name: str) -> list[str]:
    """Every module under ``src/`` that reads ``.<field_name>``, excluding the declaring
    module (its declaration and its own validator) and this port's unrelated namesakes.

    Matched as an ATTRIBUTE access (``.column_naming``) rather than a bare word, so a
    same-named local, parameter or keyword argument elsewhere cannot vouch for the field.
    """
    pattern = re.compile(rf"\.{re.escape(field_name)}\b")
    hits: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        if path == DECLARING_MODULE:
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            hits.append(str(path.relative_to(SRC)))
    return hits


def test_every_gen_config_field_is_read_somewhere_or_declared_inert() -> None:
    dead: list[str] = []
    for f in dataclasses.fields(GenConfig):
        if f.name in INERT_BY_DESIGN:
            continue
        if not _reads_of(f.name):
            dead.append(f.name)
    assert dead == [], (
        f"GenConfig field(s) {dead} are read by nothing under src/. A config field nobody "
        "reads accepts a value, reports success and changes nothing. Wire it to the code "
        "that should honour it, refuse the values it cannot honour, or add it to "
        "INERT_BY_DESIGN with the reason."
    )


def test_no_inert_exemption_outlives_the_gap_it_explains() -> None:
    # An exemption for a field that HAS acquired a reader is stale prose asserting a gap
    # that closed. Same tripwire the view-renderer exemptions carry.
    stale = [name for name in INERT_BY_DESIGN if _reads_of(name)]
    assert stale == [], (
        f"{stale} now has a reader — delete its INERT_BY_DESIGN entry and gate the field's "
        "effect on output instead."
    )
    # And an exemption must name a real field, not a typo or a field since removed.
    known = {f.name for f in dataclasses.fields(GenConfig)}
    assert set(INERT_BY_DESIGN) <= known, f"unknown field(s): {set(INERT_BY_DESIGN) - known}"
