from metaobjects.meta.meta_data import MetaData


class _N(MetaData):
    pass


def test_effective_package_walks_to_nearest_ancestor() -> None:
    root = _N("metadata", "root", "")
    root.package = "acme::commerce"
    obj = _N("object", "entity", "Product")          # no explicit package
    root.add_child(obj)
    fld = _N("field", "long", "id")
    obj.add_child(fld)
    assert obj.effective_package() == "acme::commerce"   # inherited from root
    assert obj.effective_fqn() == "acme::commerce::Product"
    # explicit package on the node wins
    obj.package = "acme::other"
    assert obj.effective_package() == "acme::other"
