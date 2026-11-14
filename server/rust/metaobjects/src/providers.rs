//! Providers: the units that register vocabulary into a [`TypeRegistry`].
//!
//! The metamodel itself is data. Every port reads the same `spec/metamodel/*.json`
//! provider definitions, so the vocabulary cannot drift between languages; this
//! module embeds those files at compile time and lowers them exactly as the
//! TypeScript reference does (`provider-data.ts`, `core-types.ts`).

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::Value;

use crate::errors::{
    ERR_PROVIDER_DEPENDENCY_CYCLE, ERR_PROVIDER_DUPLICATE_ID, ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_UNKNOWN, MetaError,
};
use crate::registry::{
    AttrSchema, ChildRule, ChildSubType, ReferenceDescriptor, SUBTYPE_BASE, TypeDefinition,
    TypeRegistry, WILDCARD,
};

pub const CORE_TYPES_ID: &str = "metaobjects-core-types";
pub const DB_ID: &str = "metaobjects-db";
pub const DOCUMENTATION_ID: &str = "metaobjects-documentation";
pub const PROMPT_ID: &str = "metaobjects-prompt";
pub const UI_ID: &str = "metaobjects-ui";
pub const UI_WEB_ID: &str = "metaobjects-ui-web";

/// A provider: an id, the providers it builds on, and what it registers.
#[derive(Clone)]
pub struct Provider {
    pub id: String,
    pub dependencies: Vec<String>,
    pub description: String,
    pub register: fn(&mut TypeRegistry) -> Result<(), MetaError>,
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provider")
            .field("id", &self.id)
            .field("dependencies", &self.dependencies)
            .finish()
    }
}

impl Provider {
    pub fn new(
        id: &str,
        dependencies: &[&str],
        description: &str,
        register: fn(&mut TypeRegistry) -> Result<(), MetaError>,
    ) -> Self {
        Self {
            id: id.to_string(),
            dependencies: dependencies.iter().map(|d| d.to_string()).collect(),
            description: description.to_string(),
            register,
        }
    }
}

// --- the embedded metamodel ---------------------------------------------------

macro_rules! spec {
    ($name:literal) => {
        (
            $name,
            include_str!(concat!("../../../../spec/metamodel/", $name, ".json")),
        )
    };
}

/// The core families, in the order the core provider registers them.
const CORE_FAMILIES: &[(&str, &str)] = &[
    spec!("object"),
    spec!("field"),
    spec!("attr"),
    spec!("validator"),
    spec!("view"),
    spec!("layout"),
    spec!("source"),
    spec!("origin"),
    spec!("template"),
    spec!("identity"),
    spec!("relationship"),
    spec!("index"),
    spec!("requirement"),
    spec!("reporting"),
];

const DB_SPEC: (&str, &str) = spec!("db");
const DOCUMENTATION_SPEC: (&str, &str) = spec!("documentation");
const PROMPT_SPEC: (&str, &str) = spec!("prompt");
const UI_SPEC: (&str, &str) = spec!("ui");
const UI_WEB_SPEC: (&str, &str) = spec!("ui-web");

/// One child entry of a provider definition: an attr, or a structural child rule.
#[derive(Debug, Clone)]
struct ChildDef {
    type_name: String,
    sub_type: Option<ChildSubType>,
    name: String,
    min: i64,
    max: Option<i64>,
    named: Option<bool>,
    description: Option<String>,
    rules: Option<String>,
    example: Option<String>,
    when_to_use: Option<String>,
    default: Option<Value>,
    allowed_values: Option<Vec<Value>>,
    is_array: Option<bool>,
    ports: Option<Vec<String>>,
    implemented_in: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct TypeDef {
    type_name: String,
    sub_type: String,
    description: String,
    data_type: Option<String>,
    rules: Option<String>,
    example: Option<String>,
    when_to_use: Option<String>,
    implemented_in: Option<Vec<String>>,
    children: Vec<ChildDef>,
    parents: Option<Vec<String>>,
    extends_base: bool,
    max_occurs: Option<i64>,
    default_name: Option<String>,
}

#[derive(Debug, Clone)]
struct ExtendDef {
    type_name: String,
    sub_type: ChildSubType,
    children: Vec<ChildDef>,
}

#[derive(Debug, Clone)]
struct ProviderDefinition {
    provider: String,
    types: Vec<TypeDef>,
    extends: Vec<ExtendDef>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn strings(v: &Value, key: &str) -> Option<Vec<String>> {
    v.get(key).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn sub_type_sel(v: Option<&Value>) -> Option<ChildSubType> {
    match v? {
        Value::String(s) => Some(ChildSubType::One(s.clone())),
        Value::Array(a) => Some(ChildSubType::Many(
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )),
        _ => None,
    }
}

fn parse_child(v: &Value) -> ChildDef {
    ChildDef {
        type_name: s(v, "type").unwrap_or_default(),
        sub_type: sub_type_sel(v.get("subType")),
        name: s(v, "name").unwrap_or_default(),
        min: v.get("min").and_then(Value::as_i64).unwrap_or(0),
        max: v.get("max").and_then(Value::as_i64),
        named: v.get("named").and_then(Value::as_bool),
        description: s(v, "description"),
        rules: s(v, "rules"),
        example: s(v, "example"),
        when_to_use: s(v, "whenToUse"),
        default: v.get("default").cloned(),
        allowed_values: v.get("allowedValues").and_then(Value::as_array).cloned(),
        is_array: v.get("isArray").and_then(Value::as_bool),
        ports: strings(v, "ports"),
        implemented_in: strings(v, "implementedIn"),
    }
}

fn children_of(v: &Value) -> Vec<ChildDef> {
    v.get("children")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(parse_child).collect())
        .unwrap_or_default()
}

fn parse_definition(file: &str, raw: &str) -> ProviderDefinition {
    let doc: Value = serde_json::from_str(raw)
        .unwrap_or_else(|e| panic!("spec/metamodel/{file}.json is not valid JSON: {e}"));
    let types = doc
        .get("types")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| TypeDef {
                    type_name: s(t, "type").unwrap_or_default(),
                    sub_type: s(t, "subType").unwrap_or_default(),
                    description: s(t, "description").unwrap_or_default(),
                    data_type: s(t, "dataType"),
                    rules: s(t, "rules"),
                    example: s(t, "example"),
                    when_to_use: s(t, "whenToUse"),
                    implemented_in: strings(t, "implementedIn"),
                    children: children_of(t),
                    parents: strings(t, "parents"),
                    extends_base: t.get("extendsBase").and_then(Value::as_bool) == Some(true),
                    max_occurs: t.get("maxOccurs").and_then(Value::as_i64),
                    default_name: s(t, "defaultName"),
                })
                .collect()
        })
        .unwrap_or_default();
    let extends = doc
        .get("extends")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| ExtendDef {
                    type_name: s(e, "type").unwrap_or_default(),
                    sub_type: sub_type_sel(e.get("subType"))
                        .unwrap_or(ChildSubType::One(WILDCARD.to_string())),
                    children: children_of(e),
                })
                .collect()
        })
        .unwrap_or_default();
    ProviderDefinition {
        provider: s(&doc, "provider").unwrap_or_default(),
        types,
        extends,
    }
}

/// The parsed definitions, parsed once per process.
struct Definitions {
    core: Vec<ProviderDefinition>,
    db: ProviderDefinition,
    documentation: ProviderDefinition,
    prompt: ProviderDefinition,
    ui: ProviderDefinition,
    ui_web: ProviderDefinition,
}

fn definitions() -> &'static Definitions {
    static DEFS: OnceLock<Definitions> = OnceLock::new();
    DEFS.get_or_init(|| {
        let p = |(name, raw): (&str, &str)| parse_definition(name, raw);
        Definitions {
            core: CORE_FAMILIES.iter().map(|f| p(*f)).collect(),
            db: p(DB_SPEC),
            documentation: p(DOCUMENTATION_SPEC),
            prompt: p(PROMPT_SPEC),
            ui: p(UI_SPEC),
            ui_web: p(UI_WEB_SPEC),
        }
    })
}

// --- lowering -------------------------------------------------------------------

const ATTR_CHILD_TYPE: &str = "attr";

fn is_universal(t: &TypeDef) -> bool {
    t.type_name == WILDCARD && t.sub_type == WILDCARD
}

fn bad_definition(message: String) -> MetaError {
    MetaError::code(ERR_UNKNOWN, message)
}

fn validate_cardinality(provider: &str, key: &str, child: &ChildDef) -> Result<(), MetaError> {
    if child.min < 0 {
        return Err(bad_definition(format!(
            "defineProviderFromData({provider}): child \"{}\" on \"{key}\" has min {} < 0.",
            child.name, child.min
        )));
    }
    if let Some(max) = child.max
        && max < child.min
    {
        return Err(bad_definition(format!(
            "defineProviderFromData({provider}): child \"{}\" on \"{key}\" has max {max} < min {}.",
            child.name, child.min
        )));
    }
    if child.type_name == ATTR_CHILD_TYPE && child.max != Some(1) && child.is_array != Some(true) {
        return Err(bad_definition(format!(
            "defineProviderFromData({provider}): attr \"{}\" on \"{key}\" is single-valued (max must be 1; a list-valued attr sets isArray: true).",
            child.name
        )));
    }
    Ok(())
}

fn to_attr_schema(provider: &str, key: &str, child: &ChildDef) -> Result<AttrSchema, MetaError> {
    let value_type = match &child.sub_type {
        None => None,
        Some(ChildSubType::One(s)) => Some(s.clone()),
        Some(ChildSubType::Many(_)) => {
            return Err(bad_definition(format!(
                "defineProviderFromData({provider}): attr \"{}\" on \"{key}\" declares a list subType — an attr's value-type is a single subtype.",
                child.name
            )));
        }
    };
    Ok(AttrSchema {
        name: child.name.clone(),
        value_type,
        is_array: child.is_array,
        required: child.min >= 1,
        default: child.default.clone(),
        allowed_values: child.allowed_values.clone(),
        ports: child.ports.clone(),
        implemented_in: child.implemented_in.clone(),
        description: child.description.clone().unwrap_or_default(),
        rules: child.rules.clone(),
        example: child.example.clone(),
        when_to_use: child.when_to_use.clone(),
    })
}

fn to_child_rule(child: &ChildDef) -> ChildRule {
    ChildRule {
        child_type: child.type_name.clone(),
        child_sub_type: child
            .sub_type
            .clone()
            .unwrap_or(ChildSubType::One(WILDCARD.to_string())),
        child_name: child.name.clone(),
        min: Some(child.min),
        max: Some(child.max),
        named: child.named,
    }
}

fn child_rule_id(rule: &ChildRule) -> String {
    let sub = match &rule.child_sub_type {
        ChildSubType::One(s) => s.clone(),
        ChildSubType::Many(list) => {
            let mut l = list.clone();
            l.sort();
            l.join("|")
        }
    };
    let max = match rule.max {
        None => String::new(),
        Some(None) => "null".to_string(),
        Some(Some(m)) => m.to_string(),
    };
    format!(
        "{} {} {} {} {} {}",
        rule.child_type,
        sub,
        rule.child_name,
        rule.min.map(|m| m.to_string()).unwrap_or_default(),
        max,
        rule.named.map(|n| n.to_string()).unwrap_or_default()
    )
}

/// Lower a definition's real types (not the universal `*.*` entry) to registry
/// definitions, folding `<type>.base` into subtypes that set `extendsBase`.
fn define_from_data(data: &ProviderDefinition) -> Result<Vec<TypeDefinition>, MetaError> {
    let real: Vec<&TypeDef> = data.types.iter().filter(|t| !is_universal(t)).collect();
    let mut lowered: Vec<(String, Vec<AttrSchema>, Vec<ChildRule>)> = Vec::new();
    for t in &real {
        let key = format!("{}.{}", t.type_name, t.sub_type);
        let mut attrs = Vec::new();
        let mut rules = Vec::new();
        for child in &t.children {
            validate_cardinality(&data.provider, &key, child)?;
            if child.type_name == ATTR_CHILD_TYPE {
                attrs.push(to_attr_schema(&data.provider, &key, child)?);
            } else {
                rules.push(to_child_rule(child));
            }
        }
        lowered.push((key, attrs, rules));
    }
    let mut out = Vec::new();
    for (t, (_, own_attrs, own_rules)) in real.iter().zip(lowered.iter()) {
        let mut attributes = own_attrs.clone();
        let mut child_rules = own_rules.clone();
        if t.extends_base && t.sub_type != SUBTYPE_BASE {
            let base_key = format!("{}.{SUBTYPE_BASE}", t.type_name);
            if let Some((_, base_attrs, base_rules)) =
                lowered.iter().find(|(k, _, _)| *k == base_key)
            {
                let mut have: HashSet<String> = attributes.iter().map(|a| a.name.clone()).collect();
                for a in base_attrs {
                    if have.insert(a.name.clone()) {
                        attributes.push(a.clone());
                    }
                }
                let mut have_rule: HashSet<String> =
                    child_rules.iter().map(child_rule_id).collect();
                for r in base_rules {
                    if have_rule.insert(child_rule_id(r)) {
                        child_rules.push(r.clone());
                    }
                }
            }
        }
        let mut def = TypeDefinition::new(&t.type_name, &t.sub_type, &t.description);
        def.attributes = attributes;
        def.child_rules = child_rules;
        def.data_type = t.data_type.clone();
        def.parents = t.parents.clone();
        def.rules = t.rules.clone();
        def.example = t.example.clone();
        def.when_to_use = t.when_to_use.clone();
        def.implemented_in = t.implemented_in.clone();
        def.max_occurs = t.max_occurs;
        def.default_name = t.default_name.clone();
        out.push(def);
    }
    Ok(out)
}

fn apply_definition(
    registry: &mut TypeRegistry,
    data: &ProviderDefinition,
) -> Result<(), MetaError> {
    for def in define_from_data(data)? {
        registry.register(def)?;
    }
    if let Some(universal) = data.types.iter().find(|t| is_universal(t)) {
        let key = format!("{}.{}", universal.type_name, universal.sub_type);
        let mut common = Vec::new();
        for child in &universal.children {
            if child.type_name != ATTR_CHILD_TYPE {
                return Err(bad_definition(format!(
                    "applyProviderDefinition({}): the universal \"{key}\" entry may only carry attr children (common attrs); found a structural child \"{}\".",
                    data.provider, child.type_name
                )));
            }
            validate_cardinality(&data.provider, &key, child)?;
            common.push(to_attr_schema(&data.provider, &key, child)?);
        }
        if !common.is_empty() {
            registry.register_common_attrs(common)?;
        }
    }
    for ext in &data.extends {
        let mut attributes = Vec::new();
        for child in &ext.children {
            if child.type_name != ATTR_CHILD_TYPE {
                return Err(bad_definition(format!(
                    "applyProviderDefinition({}): extends \"{}\" may only carry attr children; found a structural child \"{}\".",
                    data.provider, ext.type_name, child.type_name
                )));
            }
            validate_cardinality(&data.provider, &ext.type_name, child)?;
            attributes.push(to_attr_schema(&data.provider, &ext.type_name, child)?);
        }
        let sub_types = match &ext.sub_type {
            ChildSubType::One(s) if s == WILDCARD => registry.all_sub_types_of(&ext.type_name),
            ChildSubType::One(s) => vec![s.clone()],
            ChildSubType::Many(list) => list.clone(),
        };
        for sub in sub_types {
            registry.extend(&ext.type_name, &sub, attributes.clone(), Vec::new())?;
        }
    }
    Ok(())
}

// --- the built-in providers ------------------------------------------------------

fn register_core(registry: &mut TypeRegistry) -> Result<(), MetaError> {
    let mut root = TypeDefinition::new("metadata", "root", "Root metadata document");
    root.child_rules = ["object", "field", "validator", "template", "requirement"]
        .iter()
        .map(|t| ChildRule::wildcard(t))
        .collect();
    registry.register(root)?;
    for family in &definitions().core {
        for def in define_from_data(family)? {
            registry.register(def)?;
        }
    }
    let reference = |attr: &str, dotted: bool, code: &str| ReferenceDescriptor {
        attr: attr.to_string(),
        target_type: "object".to_string(),
        dotted_field_path: dotted,
        error_code: code.to_string(),
    };
    for sub in registry.all_sub_types_of("relationship") {
        if let Some(def) = registry.find_mut("relationship", &sub) {
            def.references = vec![reference("objectRef", false, "ERR_INVALID_RELATIONSHIP")];
        }
    }
    if let Some(def) = registry.find_mut("identity", "reference") {
        def.references = vec![reference("references", true, "ERR_INVALID_REFERENCE")];
    }
    for sub in ["object", "map"] {
        if let Some(def) = registry.find_mut("field", sub) {
            def.references = vec![reference("objectRef", false, "ERR_UNRESOLVED_OBJECT_REF")];
        }
    }
    registry.set_default_sub_type("metadata", "root")?;
    registry.set_default_sub_type("object", "entity")?;
    Ok(())
}

pub fn core_types_provider() -> Provider {
    Provider::new(
        CORE_TYPES_ID,
        &[],
        "Core metaobjects metamodel types and subtypes.",
        register_core,
    )
}

pub fn db_provider() -> Provider {
    Provider::new(
        DB_ID,
        &[CORE_TYPES_ID],
        "DB-domain attributes: column names, indexes and physical column types.",
        |r| apply_definition(r, &definitions().db),
    )
}

pub fn documentation_provider() -> Provider {
    Provider::new(
        DOCUMENTATION_ID,
        &[CORE_TYPES_ID],
        "Universal documentation common attrs accepted on every metatype.",
        |r| apply_definition(r, &definitions().documentation),
    )
}

pub fn prompt_provider() -> Provider {
    Provider::new(
        PROMPT_ID,
        &[CORE_TYPES_ID],
        "Prompt, AI and serialization attributes.",
        |r| apply_definition(r, &definitions().prompt),
    )
}

pub fn ui_provider() -> Provider {
    Provider::new(
        UI_ID,
        &[CORE_TYPES_ID],
        "Filter and sort field markers for generated query surfaces.",
        |r| apply_definition(r, &definitions().ui),
    )
}

pub fn ui_web_provider() -> Provider {
    Provider::new(
        UI_WEB_ID,
        &[CORE_TYPES_ID],
        "Web presentation view attrs.",
        |r| apply_definition(r, &definitions().ui_web),
    )
}

/// The full built-in set, as the registry manifest is built from it.
pub fn core_providers() -> Vec<Provider> {
    vec![
        core_types_provider(),
        db_provider(),
        documentation_provider(),
        prompt_provider(),
        ui_provider(),
        ui_web_provider(),
    ]
}

/// Look up a built-in provider by id (`metaobjects-template` is the retired name
/// of the prompt provider, kept because older fixtures still use it).
pub fn builtin_provider(id: &str) -> Option<Provider> {
    match id {
        CORE_TYPES_ID => Some(core_types_provider()),
        DB_ID => Some(db_provider()),
        DOCUMENTATION_ID => Some(documentation_provider()),
        PROMPT_ID | "metaobjects-template" => Some(prompt_provider()),
        UI_ID => Some(ui_provider()),
        UI_WEB_ID => Some(ui_web_provider()),
        _ => None,
    }
}

/// Order providers so each follows its dependencies, then run them into a new
/// registry. The registry is returned unsealed; call [`TypeRegistry::seal`].
pub fn compose_registry(providers: &[Provider]) -> Result<TypeRegistry, MetaError> {
    let mut ids = HashSet::new();
    for p in providers {
        if !ids.insert(p.id.as_str()) {
            return Err(MetaError::code(
                ERR_PROVIDER_DUPLICATE_ID,
                format!("composeRegistry: duplicate provider id \"{}\"", p.id),
            ));
        }
    }
    for p in providers {
        for dep in &p.dependencies {
            if !ids.contains(dep.as_str()) {
                return Err(MetaError::code(
                    ERR_PROVIDER_MISSING_DEPENDENCY,
                    format!(
                        "composeRegistry: provider \"{}\" depends on \"{dep}\", which is not in the provider set",
                        p.id
                    ),
                ));
            }
        }
    }
    let mut emitted: HashSet<&str> = HashSet::new();
    let mut ordered: Vec<&Provider> = Vec::new();
    while ordered.len() < providers.len() {
        let next = providers.iter().find(|p| {
            !emitted.contains(p.id.as_str())
                && p.dependencies.iter().all(|d| emitted.contains(d.as_str()))
        });
        let Some(next) = next else {
            let stuck: Vec<&str> = providers
                .iter()
                .filter(|p| !emitted.contains(p.id.as_str()))
                .map(|p| p.id.as_str())
                .collect();
            return Err(MetaError::code(
                ERR_PROVIDER_DEPENDENCY_CYCLE,
                format!(
                    "composeRegistry: dependency cycle among providers [{}]",
                    stuck.join(", ")
                ),
            ));
        };
        emitted.insert(next.id.as_str());
        ordered.push(next);
    }
    let mut registry = TypeRegistry::new();
    for p in ordered {
        registry.run_as_provider(&p.id, |r| (p.register)(r))?;
    }
    Ok(registry)
}

/// The built-in registry, sealed: what an application loads metadata with.
pub fn default_registry() -> Result<TypeRegistry, MetaError> {
    let mut registry = compose_registry(&core_providers())?;
    registry.seal();
    Ok(registry)
}
