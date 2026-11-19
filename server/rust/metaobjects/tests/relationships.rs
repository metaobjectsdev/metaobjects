//! Relationship validation cases the shared corpus does not pin: the valid shapes
//! (so the rules do not over-reject) and the reference-ladder name pairing.

use metaobjects::loader::Loader;
use metaobjects::providers::default_registry;

fn codes(doc: &str) -> Vec<&'static str> {
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry).load_sources(&[("meta.a.json".to_string(), doc.to_string())]);
    r.errors.iter().map(|e| e.code).collect()
}

fn entity(name: &str, extra: &str) -> String {
    format!(
        r#"{{"object.entity": {{"name": "{name}", "children": [
          {{"source.rdb": {{"@table": "t_{name}"}}}},
          {{"field.long": {{"name": "id"}}}},
          {{"identity.primary": {{"name": "pk", "@fields": ["id"]}}}}{extra}]}}}}"#
    )
}

fn doc(entities: &[String]) -> String {
    format!(
        r#"{{"metadata.root": {{"package": "acme", "children": [{}]}}}}"#,
        entities.join(",")
    )
}

fn junction(a: &str, b: &str) -> String {
    entity(
        "Link",
        &format!(
            r#",{{"field.long": {{"name": "aId"}}}},{{"field.long": {{"name": "bId"}}}},
            {{"identity.reference": {{"name": "ra", "@fields": ["aId"], "@references": "{a}"}}}},
            {{"identity.reference": {{"name": "rb", "@fields": ["bId"], "@references": "{b}"}}}}"#
        ),
    )
}

fn m2m(attrs: &str) -> String {
    format!(
        r#",{{"relationship.association": {{"name": "others", "@cardinality": "many",
          "@through": "Link", "@objectRef": "Tag"{attrs}}}}}"#
    )
}

#[test]
fn a_heterogeneous_m2m_through_a_paired_junction_loads_clean() {
    let d = doc(&[
        entity("Post", &m2m("")),
        entity("Tag", ""),
        junction("Post", "Tag"),
    ]);
    assert_eq!(codes(&d), Vec::<&str>::new());
}

#[test]
fn a_junction_that_never_names_the_navigating_entity_is_unpairable() {
    let d = doc(&[
        entity("Post", &m2m("")),
        entity("Tag", ""),
        entity("Other", ""),
        junction("Tag", "Other"),
    ]);
    assert_eq!(codes(&d), ["ERR_INVALID_RELATIONSHIP"]);
}

#[test]
fn symmetric_is_valid_on_a_self_join() {
    let rel = r#",{"relationship.association": {"name": "friends", "@cardinality": "many",
        "@through": "Link", "@objectRef": "Person", "@symmetric": true}}"#;
    let d = doc(&[entity("Person", rel), junction("Person", "Person")]);
    assert_eq!(codes(&d), Vec::<&str>::new());
}

#[test]
fn a_one_side_relationship_pairs_with_one_of_two_references_by_name() {
    let refs = r#",{"field.long": {"name": "homeId"}},{"field.long": {"name": "awayId"}},
        {"identity.reference": {"name": "home", "@fields": ["homeId"], "@references": "Team"}},
        {"identity.reference": {"name": "away", "@fields": ["awayId"], "@references": "Team"}},
        {"relationship.association": {"name": "home", "@cardinality": "one", "@objectRef": "Team"}}"#;
    let d = doc(&[entity("Match", refs), entity("Team", "")]);
    assert_eq!(codes(&d), Vec::<&str>::new());
}

#[test]
fn a_one_side_relationship_matching_no_reference_name_is_ambiguous() {
    let refs = r#",{"field.long": {"name": "homeId"}},{"field.long": {"name": "awayId"}},
        {"identity.reference": {"name": "home", "@fields": ["homeId"], "@references": "Team"}},
        {"identity.reference": {"name": "away", "@fields": ["awayId"], "@references": "Team"}},
        {"relationship.association": {"name": "team", "@cardinality": "one", "@objectRef": "Team"}}"#;
    let d = doc(&[entity("Match", refs), entity("Team", "")]);
    assert_eq!(codes(&d), ["ERR_INVALID_RELATIONSHIP"]);
}
