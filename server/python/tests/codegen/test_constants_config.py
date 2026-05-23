from metaobjects.codegen.constants import GENERATED_MARKER, generated_header
from metaobjects.codegen.config import GenConfig
from metaobjects.meta.core.field import field_constants as fc


def test_generated_header_contains_marker_and_names():
    h = generated_header("Subscriber", "myapp::users::Subscriber")
    assert GENERATED_MARKER in h
    assert "Subscriber" in h and "myapp::users::Subscriber" in h
    assert "Subscriber_extra.py" in h
    assert h.endswith("\n")


def test_genconfig_defaults():
    cfg = GenConfig(out_dir="out")
    assert cfg.out_dir == "out"
    assert cfg.output_layout == "flat"


def test_field_attr_name_constants():
    assert fc.FIELD_ATTR_REQUIRED == "required"
    assert fc.FIELD_ATTR_MAX_LENGTH == "maxLength"
    assert fc.FIELD_ATTR_OBJECT_REF == "objectRef"
    assert fc.FIELD_ATTR_DEFAULT == "default"
