"""Helper source ``metaobjects eject`` hands over with a generator.

Two kinds of module live here, and eject copies both into the adopter's
``codegen/runtime/`` (helper tier, not core: ADR-0034 Amendment 3).

``filter_parser`` and ``constraint_errors`` are what generated routers import. Generated
code from the PACKAGED ``routes`` generator imports them from this package directly; an
owned ``routes`` emits the adopter's copy into the generated package instead. So each must
stay self-contained — standard library only, no ``metaobjects`` import and no FastAPI /
SQLAlchemy / pg8000 dependency — or the copy would not run on its own.

``shared_predicates`` is what several GENERATORS import, at ``gen`` time: the emit rules
they have to agree on. No generated code imports it, so it may import ``metaobjects``.
"""
