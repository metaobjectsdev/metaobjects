import json

from metaobjects import MetaDataLoader
from metaobjects.loader.sources.file_source import FileSource


def test_file_source_id_defaults_to_basename_and_accepts_override(tmp_path):
    p = tmp_path / "meta.a.json"
    p.write_text(json.dumps({"metadata.root": {"package": "p", "children": [{"object.value": {"name": "V"}}]}}))
    assert FileSource(p).id == "meta.a.json"
    src = FileSource(p, id="dep:acme-common/acme-common.metaobjects.json")
    assert src.id == "dep:acme-common/acme-common.metaobjects.json"
    res = MetaDataLoader().load([src])
    assert not res.errors
    node = next(c for c in res.root.own_children())  # ADR-0039 sanctioned own: root-level scan
    # source.files is a tuple (existing Python convention — see test_source_on_node.py).
    assert node.source.files == ("dep:acme-common/acme-common.metaobjects.json",)
