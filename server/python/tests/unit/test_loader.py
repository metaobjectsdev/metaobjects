import json
from pathlib import Path

from metaobjects.loader.meta_data_loader import load_directory
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
    result = load_directory(str(tmp_path))
    assert not result.errors
    assert result.root.frozen
    out = json.loads(canonical_serialize(result.root))
    assert out["metadata.root"]["children"][0]["object.entity"]["children"][1] == {
        "identity.primary": {"@fields": ["id"]}
    }
