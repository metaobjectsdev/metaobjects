"""ADR-0058 Amendment 1 — the stock ``metaobjects`` console script imports the project's
providers (``providers:`` in ``metaobjects.config.yaml``) BEFORE it reads
``.metaobjects/config.json``, so a provider module that registers a naming strategy when it is
imported is registered in time for ``naming`` to select it. No host runner is needed."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from metaobjects.cli import main

PROVIDER_MODULE = '''
from metaobjects.naming import register_column_naming_strategy
from metaobjects.provider import Provider

# Registered when the module is imported: the console script imports it before it reads
# .metaobjects/config.json.
register_column_naming_strategy("py-import-time-cols", lambda n: "col_" + n)

naming_provider = Provider("test-import-time-naming", ("metaobjects-core-types",))
'''

META = {
    "metadata.root": {
        "package": "acme::clinic",
        "children": [
            {
                "object.entity": {
                    "name": "Patient",
                    "children": [
                        {"source.rdb": {"name": "src", "@table": "patients"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "firstName"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            }
        ],
    }
}


def test_a_provider_module_registers_a_naming_strategy_at_import_time(tmp_path: Path) -> None:
    from metaobjects.naming import reset_naming_strategies_for_testing

    meta = tmp_path / "metaobjects_meta"
    meta.mkdir()
    (meta / "meta.json").write_text(json.dumps(META))
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "naming": {"columns": "py-import-time-cols"}})
    )
    (tmp_path / "acme_naming_prov.py").write_text(PROVIDER_MODULE)
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        """
        metadata: metaobjects_meta
        providers: ["acme_naming_prov:naming_provider"]
        targets:
          models:
            outDir: gen
            generators: [entity, names]
        """
    )
    try:
        rc = main(["gen", "--config", str(cfg)])
    finally:
        if str(tmp_path) in sys.path:
            sys.path.remove(str(tmp_path))
        sys.modules.pop("acme_naming_prov", None)
        reset_naming_strategies_for_testing()
    assert rc == 0
    # The names artifact spells the column the app strategy resolved.
    generated = "\n".join(p.read_text() for p in (tmp_path / "gen").rglob("*.py"))
    assert '"col_firstName"' in generated
