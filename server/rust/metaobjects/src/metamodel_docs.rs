//! The metamodel reference pages' data: what the shared Mustache templates
//! (`templates/metamodel/`) render as `INDEX.md`, `providers.md` and one
//! `types/<family>.md` per type family.
//!
//! The pages document the metamodel itself (the type, subtype and attr vocabulary of the
//! strict registry), not a user's entities. The data comes from two inputs this port
//! already holds: its registry vocabulary manifest ([`crate::manifest::build_manifest`]) and
//! its embedded provider definitions ([`crate::providers::DEFINITION_SOURCES`]), which are
//! the only place provider ownership and attr defaults live (the manifest is provider-blind,
//! ADR-0050), plus each provider's one-line description. The builder makes every decision
//! (sorting, table cells, joined lists, links); a template only lays the lines out. The data
//! is pinned by `fixtures/metamodel-docs/data/`, the pages by `fixtures/metamodel-docs/expected/`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::json::js_display;
use crate::providers::DEFINITION_SOURCES;
use crate::registry::SUBTYPE_BASE;

/// The shared template of `INDEX.md`.
pub const INDEX_PAGE_REF: &str = "metamodel/index.md";
/// The shared template of `providers.md`.
pub const PROVIDERS_PAGE_REF: &str = "metamodel/providers.md";
/// The shared template of each `types/<family>.md`.
pub const TYPE_PAGE_REF: &str = "metamodel/type-page.md";

const ATTR_CHILD_TYPE: &str = "attr";
const NO_VALUE: &str = "\u{2014}";
const WILDCARD: &str = "*";

/// One page to render: its output path (relative), its template ref and the template's data.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub path: String,
    pub template: &'static str,
    pub data: Value,
}

/// Escape a markdown table cell: collapse newlines, escape pipes.
fn cell(s: &str) -> String {
    s.replace("\r\n", " ")
        .replace('\n', " ")
        .replace('|', "\\|")
        .trim()
        .to_string()
}

/// The anchor GitHub assigns to a `### field.currency` heading: `fieldcurrency`.
fn anchor(type_name: &str, sub_type: &str) -> String {
    format!("{type_name}{sub_type}")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// A value as an inline-code token; nothing for no value.
fn value_token(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => format!("`{}`", js_display(v)),
    }
}

fn code_list(items: &[String], prefix: &str) -> String {
    items
        .iter()
        .map(|i| format!("`{prefix}{i}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn list_of<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn attr_type_label(attr: &Value) -> String {
    let scalar = str_of(attr, "valueType").unwrap_or("any");
    if attr.get("isArray").and_then(Value::as_bool) == Some(true) {
        format!("{scalar}[]")
    } else {
        scalar.to_string()
    }
}

/// One structural child rule as its list line: `` `field.*` — 0..* ``.
fn child_line(rule: &Value) -> String {
    let child_type = str_of(rule, "childType").unwrap_or_default();
    let sub = match rule.get("childSubType") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let name = str_of(rule, "childName").unwrap_or(WILDCARD);
    let name_suffix = if name == WILDCARD {
        String::new()
    } else {
        format!(" (name `{name}`)")
    };
    let min = rule.get("min").and_then(Value::as_i64).unwrap_or(0);
    let max = rule
        .get("max")
        .and_then(Value::as_i64)
        .map_or_else(|| "*".to_string(), |m| m.to_string());
    format!("`{child_type}.{sub}`{name_suffix} \u{2014} {min}..{max}")
}

/// What the provider definitions say about one attr on one `type.subType`.
struct AttrProvenance {
    provider: String,
    default: Option<Value>,
}

struct Provenance {
    owner_of_type: HashMap<String, String>,
    attrs: HashMap<String, AttrProvenance>,
    provider_ids: Vec<String>,
    owned: HashMap<String, BTreeSet<String>>,
    contributed: HashMap<String, BTreeMap<String, BTreeSet<String>>>,
    common: HashMap<String, BTreeSet<String>>,
}

fn is_universal(t: &Value) -> bool {
    str_of(t, "type") == Some(WILDCARD) && str_of(t, "subType") == Some(WILDCARD)
}

fn attr_children(v: &Value) -> impl Iterator<Item = &Value> {
    list_of(v, "children")
        .iter()
        .filter(|c| str_of(c, "type") == Some(ATTR_CHILD_TYPE))
}

/// Walk the provider definitions: a definition's non-universal `types[]` are the
/// `type.subType`s it owns; its `extends[]` are attrs it contributes to types another
/// provider owns (`"*"` resolves to every subtype the manifest lists for that type); its
/// universal `*.*` entry's attrs are common attrs. The first declarer of an attr wins.
fn build_provenance(manifest: &Value, definitions: &[Value]) -> Provenance {
    let mut covered: HashSet<String> = HashSet::new();
    let mut sub_types_of: HashMap<String, Vec<String>> = HashMap::new();
    for t in list_of(manifest, "types") {
        let (ty, sub) = (
            str_of(t, "type").unwrap_or_default(),
            str_of(t, "subType").unwrap_or_default(),
        );
        covered.insert(format!("{ty}.{sub}"));
        sub_types_of
            .entry(ty.to_string())
            .or_default()
            .push(sub.to_string());
    }
    let mut p = Provenance {
        owner_of_type: HashMap::new(),
        attrs: HashMap::new(),
        provider_ids: Vec::new(),
        owned: HashMap::new(),
        contributed: HashMap::new(),
        common: HashMap::new(),
    };
    let mut ids: BTreeSet<String> = BTreeSet::new();

    for def in definitions {
        let id = str_of(def, "provider").unwrap_or_default().to_string();
        if ids.insert(id.clone()) {
            p.owned.insert(id.clone(), BTreeSet::new());
            p.contributed.insert(id.clone(), BTreeMap::new());
            p.common.insert(id.clone(), BTreeSet::new());
        }
        let record = |p: &mut Provenance, ty: &str, sub: &str, c: &Value| {
            let name = str_of(c, "name").unwrap_or_default();
            p.attrs
                .entry(format!("{ty}.{sub}.{name}"))
                .or_insert_with(|| AttrProvenance {
                    provider: id.clone(),
                    default: c.get("default").cloned(),
                });
            p.contributed
                .get_mut(&id)
                .expect("provider registered")
                .entry(format!("{ty}.{sub}"))
                .or_default()
                .insert(name.to_string());
        };
        for t in list_of(def, "types") {
            if is_universal(t) {
                for c in attr_children(t) {
                    p.common
                        .get_mut(&id)
                        .expect("provider registered")
                        .insert(str_of(c, "name").unwrap_or_default().to_string());
                }
                continue;
            }
            let (ty, sub) = (
                str_of(t, "type").unwrap_or_default(),
                str_of(t, "subType").unwrap_or_default(),
            );
            let tk = format!("{ty}.{sub}");
            p.owner_of_type
                .entry(tk.clone())
                .or_insert_with(|| id.clone());
            if covered.contains(&tk) {
                p.owned
                    .get_mut(&id)
                    .expect("provider registered")
                    .insert(tk);
            }
            for c in attr_children(t) {
                record(&mut p, ty, sub, c);
            }
        }
        for ext in list_of(def, "extends") {
            let ty = str_of(ext, "type").unwrap_or_default();
            let subs: Vec<String> = match ext.get("subType") {
                Some(Value::String(s)) if s == WILDCARD => {
                    sub_types_of.get(ty).cloned().unwrap_or_default()
                }
                Some(Value::String(s)) => vec![s.clone()],
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                _ => Vec::new(),
            };
            for sub in &subs {
                for c in attr_children(ext) {
                    record(&mut p, ty, sub, c);
                }
            }
        }
    }
    p.provider_ids = ids.into_iter().collect();
    p
}

fn index_data(types: &[Value]) -> Value {
    let rows: Vec<Value> = types
        .iter()
        .map(|t| {
            let (ty, sub) = (
                str_of(t, "type").unwrap_or_default(),
                str_of(t, "subType").unwrap_or_default(),
            );
            json!({
                "typeSubType": format!("{ty}.{sub}"),
                "description": cell(str_of(t, "description").unwrap_or_default()),
                "page": format!("types/{ty}.md#{}", anchor(ty, sub)),
            })
        })
        .collect();
    json!({ "rows": rows })
}

fn providers_data(p: &Provenance, descriptions: &BTreeMap<String, String>) -> Value {
    let providers: Vec<Value> = p
        .provider_ids
        .iter()
        .map(|id| {
            let description = descriptions.get(id);
            let owned: Vec<String> = p.owned[id].iter().cloned().collect();
            let common: Vec<String> = p.common[id].iter().cloned().collect();
            let contributed: Vec<Value> = p.contributed[id]
                .iter()
                .map(|(tk, attrs)| {
                    let attrs: Vec<String> = attrs.iter().cloned().collect();
                    json!({ "typeSubType": tk, "attrs": code_list(&attrs, "@") })
                })
                .collect();
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("hasDescription".into(), json!(description.is_some()));
            if let Some(d) = description {
                m.insert("description".into(), json!(d));
            }
            m.insert("hasOwns".into(), json!(!owned.is_empty()));
            if !owned.is_empty() {
                m.insert("owns".into(), json!(code_list(&owned, "")));
            }
            m.insert("hasUniversal".into(), json!(!common.is_empty()));
            if !common.is_empty() {
                m.insert("universal".into(), json!(code_list(&common, "@")));
            }
            m.insert("hasContributes".into(), json!(!contributed.is_empty()));
            m.insert("contributes".into(), Value::Array(contributed));
            Value::Object(m)
        })
        .collect();
    json!({ "providers": providers })
}

fn sorted_strings(v: &Value, key: &str) -> Vec<String> {
    let mut out: Vec<String> = list_of(v, key)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    out.sort();
    out
}

fn section_data(t: &Value, p: &Provenance, common_attr_names: &HashSet<String>) -> Value {
    let (ty, sub) = (
        str_of(t, "type").unwrap_or_default(),
        str_of(t, "subType").unwrap_or_default(),
    );
    let owner = p.owner_of_type.get(&format!("{ty}.{sub}"));
    // An attr inherited from `<type>.base` is recorded against the base in the definitions.
    let attrs: Vec<Value> = list_of(t, "attrs")
        .iter()
        .filter(|a| !common_attr_names.contains(str_of(a, "name").unwrap_or_default()))
        .map(|a| {
            let name = str_of(a, "name").unwrap_or_default();
            let prov = p
                .attrs
                .get(&format!("{ty}.{sub}.{name}"))
                .or_else(|| p.attrs.get(&format!("{ty}.{SUBTYPE_BASE}.{name}")));
            let allowed = list_of(a, "allowedValues")
                .iter()
                .map(|v| value_token(Some(v)))
                .collect::<Vec<_>>()
                .join(", ");
            json!({
                "name": name,
                "type": attr_type_label(a),
                "required": if a.get("required").and_then(Value::as_bool) == Some(true) { "yes" } else { "no" },
                "default": value_token(prov.and_then(|x| x.default.as_ref())),
                "allowed": allowed,
                "provider": prov.map_or(NO_VALUE, |x| x.provider.as_str()),
                "description": cell(str_of(a, "description").unwrap_or_default()),
            })
        })
        .collect();
    let children: Vec<String> = list_of(t, "children")
        .iter()
        .filter(|c| str_of(c, "childType") != Some(ATTR_CHILD_TYPE))
        .map(child_line)
        .collect();
    let implemented_in = sorted_strings(t, "implementedIn");
    let parents = sorted_strings(t, "parents");
    let mut m = Map::new();
    m.insert("typeSubType".into(), json!(format!("{ty}.{sub}")));
    m.insert(
        "description".into(),
        json!(str_of(t, "description").unwrap_or_default()),
    );
    m.insert("hasOwner".into(), json!(owner.is_some()));
    if let Some(o) = owner {
        m.insert("owner".into(), json!(o));
    }
    m.insert("hasImplementedIn".into(), json!(!implemented_in.is_empty()));
    if !implemented_in.is_empty() {
        m.insert("implementedIn".into(), json!(implemented_in.join(", ")));
    }
    for (flag, key) in [
        ("hasRules", "rules"),
        ("hasWhenToUse", "whenToUse"),
        ("hasExample", "example"),
    ] {
        let value = str_of(t, key);
        m.insert(flag.into(), json!(value.is_some()));
        if let Some(v) = value {
            m.insert(key.into(), json!(v));
        }
    }
    m.insert("hasAttrs".into(), json!(!attrs.is_empty()));
    m.insert("attrs".into(), Value::Array(attrs));
    m.insert("hasChildren".into(), json!(!children.is_empty()));
    m.insert("children".into(), json!(children));
    m.insert("hasParents".into(), json!(!parents.is_empty()));
    if !parents.is_empty() {
        m.insert("parents".into(), json!(code_list(&parents, "")));
    }
    Value::Object(m)
}

/// Every metamodel reference page, in output order: `INDEX.md`, `providers.md`, then one
/// `types/<family>.md` per type family, sorted. `manifest` is the registry manifest
/// ([`crate::manifest::build_manifest`]), `definitions` the parsed provider definitions
/// ([`parse_definitions`]) and `provider_descriptions` each provider's one-line description.
pub fn build_pages(
    manifest: &Value,
    definitions: &[Value],
    provider_descriptions: &BTreeMap<String, String>,
) -> Vec<Page> {
    let p = build_provenance(manifest, definitions);
    let common_attr_names: HashSet<String> = list_of(manifest, "commonAttrs")
        .iter()
        .filter_map(|a| str_of(a, "name").map(str::to_string))
        .collect();
    let types = list_of(manifest, "types");
    let mut pages = vec![
        Page {
            path: "INDEX.md".into(),
            template: INDEX_PAGE_REF,
            data: index_data(types),
        },
        Page {
            path: "providers.md".into(),
            template: PROVIDERS_PAGE_REF,
            data: providers_data(&p, provider_descriptions),
        },
    ];
    let mut by_family: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for t in types {
        by_family
            .entry(str_of(t, "type").unwrap_or_default())
            .or_default()
            .push(t);
    }
    for (family, members) in by_family {
        let sections: Vec<Value> = members
            .into_iter()
            .map(|t| section_data(t, &p, &common_attr_names))
            .collect();
        pages.push(Page {
            path: format!("types/{family}.md"),
            template: TYPE_PAGE_REF,
            data: json!({ "family": family, "sections": sections }),
        });
    }
    pages
}

/// The embedded provider definitions, parsed, in the order [`build_pages`] walks them.
pub fn parse_definitions() -> Vec<Value> {
    DEFINITION_SOURCES
        .iter()
        .map(|(name, raw)| {
            serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("spec/metamodel/{name}.json is not valid JSON: {e}"))
        })
        .collect()
}
