import json
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.serializer_json import canonical_serialize


def test_load_single_entity_dir(tmp_path: Path) -> None:
    (tmp_path / "meta.commerce.json").write_text(json.dumps({
        "metadata.root": {"package": "acme", "children": [
            {"object.entity": {"name": "P", "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"@fields": "id"}},
            ]}}
        ]}
    }))
    result = MetaDataLoader.from_directory(tmp_path)
    assert not result.errors
    assert result.root.frozen
    out = json.loads(canonical_serialize(result.root))
    # identity.primary is a singleton with a config-driven defaultName, so a
    # name-less primary is serialized named "primary".
    assert out["metadata.root"]["children"][0]["object.entity"]["children"][1] == {
        "identity.primary": {"name": "primary", "@fields": ["id"]}
    }
