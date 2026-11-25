//! ADR-0062: an attribute folded in from `<type>.base` is the base owner's; one a
//! provider declares itself under the same name is a claim, and is refused.

use metaobjects::errors::ERR_PROVIDER_ATTR_SHADOW;
use metaobjects::registry::{AttrSchema, TypeDefinition, TypeRegistry};

fn with_base() -> TypeRegistry {
    let mut r = TypeRegistry::new();
    r.run_as_provider("core", |r| {
        let mut base = TypeDefinition::new("object", "base", "base");
        base.attributes
            .push(AttrSchema::simple("discriminator", Some("string"), "d"));
        r.register(base).expect("base registers");
    });
    r
}

fn subtype(extends_base: bool) -> TypeDefinition {
    let mut def = TypeDefinition::new("object", "foo", "foo");
    def.attributes
        .push(AttrSchema::simple("discriminator", Some("string"), "d"));
    def.extends_base = extends_base;
    def
}

#[test]
fn a_folded_base_attribute_is_not_a_claim() {
    let mut r = with_base();
    r.run_as_provider("pack", |r| r.register(subtype(true)))
        .expect("a folded attribute is the base owner's");
}

#[test]
fn a_redeclared_base_attribute_is_refused() {
    let mut r = with_base();
    let err = r
        .run_as_provider("pack", |r| r.register(subtype(false)))
        .expect_err("a second provider may not claim the base attribute");
    assert_eq!(err.code, ERR_PROVIDER_ATTR_SHADOW, "{err:?}");
}
