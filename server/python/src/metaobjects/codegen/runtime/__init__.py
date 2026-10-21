"""Helper source ``metaobjects eject`` hands over with a generator.

Two kinds of module live here, and eject copies both into the adopter's
``codegen/runtime/`` (helper tier, not core: ADR-0034 Amendment 3).

``filter_parser``, ``constraint_errors`` and ``decimal_wire`` are what generated routers import. Generated
code from the PACKAGED ``routes`` generator imports them from this package directly; an
owned ``routes`` emits the adopter's copy into the generated package instead. So each must
stay self-contained — standard library only, no ``metaobjects`` import and no FastAPI /
SQLAlchemy / pg8000 dependency — or the copy would not run on its own.

Everything else is what GENERATORS import, at ``gen`` time. No generated code imports it, so
it may import ``metaobjects``. Each generator lists the ones it uses on its registry entry's
``runtime``, and an owned copy reads the copies eject placed beside it:

* ``shared_predicates`` — the emit rules several generators have to agree on.
* ``fr019_shared_enum``, ``m2m_codegen`` — the fragment writers behind the entity, routes and
  filter-allowlist generators (the shared-enum module, M:N navigation and the object index).
* ``fr010_field_mapping``, ``extract_delegate_emitter``, ``extract_schema_emitter``,
  ``output_format_spec_emitter`` — the prompt-tier emitters behind the output-parser,
  extractor, output-prompt and trace-helper generators.
* ``api_docs_model``, ``api_docs_builder``, ``api_docs_renderer``, ``api_docs_paths`` — the
  page IR, builder, renderer and path math behind ``api-docs``.

What stays a package import is the engine: the generator base and file writer, the naming
and type-mapping tables (``metaobjects.apidocs.naming``, ``type_map``, ``value_objects``),
the model walks (``find_inbound``, ``tph_plan``, ``instance_artifacts``) and the loader.
"""
