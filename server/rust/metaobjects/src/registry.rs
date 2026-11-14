//! The type registry: every `type.subType` a document may use, the attributes each
//! accepts and the children each may hold.
//!
//! Behaviour follows the TypeScript reference (`registry.ts`), including the
//! provider attribute-ownership rules of ADR-0062 and the sealing of ADR-0023.

use indexmap::IndexMap;
use serde_json::Value;

use crate::errors::{
    ERR_EXTEND_REQUIRED_ATTR, ERR_PROVIDER_ATTR_CONFLICT, ERR_PROVIDER_ATTR_SHADOW,
    ERR_REGISTRY_SEALED, ERR_UNKNOWN, MetaError,
};

/// The wildcard in a child rule (`*` matches any type, subtype or name).
pub const WILDCARD: &str = "*";
/// The abstract subtype every family's concrete subtypes build on.
pub const SUBTYPE_BASE: &str = "base";

/// One attribute a type accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct AttrSchema {
    pub name: String,
    /// The attr subtype its value has (`string`, `int`, ...); `None` is untyped.
    pub value_type: Option<String>,
    pub is_array: Option<bool>,
    pub required: bool,
    pub default: Option<Value>,
    pub allowed_values: Option<Vec<Value>>,
    pub ports: Option<Vec<String>>,
    pub implemented_in: Option<Vec<String>>,
    pub description: String,
    pub rules: Option<String>,
    pub example: Option<String>,
    pub when_to_use: Option<String>,
}

impl AttrSchema {
    /// An optional attr with only a name, value type and description.
    pub fn simple(name: &str, value_type: Option<&str>, description: &str) -> Self {
        Self {
            name: name.to_string(),
            value_type: value_type.map(str::to_string),
            is_array: None,
            required: false,
            default: None,
            allowed_values: None,
            ports: None,
            implemented_in: None,
            description: description.to_string(),
            rules: None,
            example: None,
            when_to_use: None,
        }
    }
}

/// The subtype half of a child rule: one subtype (or `*`) or a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildSubType {
    One(String),
    Many(Vec<String>),
}

impl ChildSubType {
    pub fn matches(&self, sub_type: &str) -> bool {
        match self {
            ChildSubType::One(s) => s == WILDCARD || s == sub_type,
            ChildSubType::Many(list) => list.iter().any(|s| s == sub_type),
        }
    }
}

/// One kind of structural child a type may hold.
#[derive(Debug, Clone, PartialEq)]
pub struct ChildRule {
    pub child_type: String,
    pub child_sub_type: ChildSubType,
    pub child_name: String,
    pub min: Option<i64>,
    /// `Some(None)` is an explicit unbounded maximum (`"max": null`).
    pub max: Option<Option<i64>>,
    pub named: Option<bool>,
}

impl ChildRule {
    /// A rule accepting any child of `child_type`.
    pub fn wildcard(child_type: &str) -> Self {
        Self {
            child_type: child_type.to_string(),
            child_sub_type: ChildSubType::One(WILDCARD.to_string()),
            child_name: WILDCARD.to_string(),
            min: None,
            max: None,
            named: None,
        }
    }

    pub fn matches(&self, child_type: &str, sub_type: &str, name: &str) -> bool {
        (self.child_type == WILDCARD || self.child_type == child_type)
            && self.child_sub_type.matches(sub_type)
            && (self.child_name == WILDCARD || self.child_name == name)
    }
}

/// An attribute whose value names another node, and the code reported when it
/// does not resolve. Recorded now; the reference pass that reads it is later work.
#[derive(Debug, Clone, PartialEq)]
pub struct ReferenceDescriptor {
    pub attr: String,
    pub target_type: String,
    pub dotted_field_path: bool,
    pub error_code: String,
}

/// Everything the registry knows about one `type.subType`.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeDefinition {
    pub type_name: String,
    pub sub_type: String,
    pub description: String,
    pub child_rules: Vec<ChildRule>,
    pub attributes: Vec<AttrSchema>,
    pub data_type: Option<String>,
    pub parents: Option<Vec<String>>,
    pub rules: Option<String>,
    pub example: Option<String>,
    pub when_to_use: Option<String>,
    pub implemented_in: Option<Vec<String>>,
    pub max_occurs: Option<i64>,
    pub default_name: Option<String>,
    pub references: Vec<ReferenceDescriptor>,
}

impl TypeDefinition {
    pub fn new(type_name: &str, sub_type: &str, description: &str) -> Self {
        Self {
            type_name: type_name.to_string(),
            sub_type: sub_type.to_string(),
            description: description.to_string(),
            child_rules: Vec::new(),
            attributes: Vec::new(),
            data_type: None,
            parents: None,
            rules: None,
            example: None,
            when_to_use: None,
            implemented_in: None,
            max_occurs: None,
            default_name: None,
            references: Vec::new(),
        }
    }

    pub fn key(&self) -> String {
        format!("{}.{}", self.type_name, self.sub_type)
    }

    pub fn attr(&self, name: &str) -> Option<&AttrSchema> {
        self.attributes.iter().find(|a| a.name == name)
    }
}

/// The registry. Built by composing providers (see [`crate::providers`]).
#[derive(Debug, Default, Clone)]
pub struct TypeRegistry {
    defs: IndexMap<String, TypeDefinition>,
    current_provider: Option<String>,
    attr_owners: IndexMap<String, IndexMap<String, String>>,
    common_attr_owners: IndexMap<String, String>,
    sub_types: IndexMap<String, Vec<String>>,
    default_sub_types: IndexMap<String, String>,
    common_attrs: Vec<AttrSchema>,
    sealed: bool,
}

fn plain(message: String) -> MetaError {
    MetaError::code(ERR_UNKNOWN, message)
}

impl TypeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Refuse every later registration (ADR-0023).
    pub fn seal(&mut self) {
        self.sealed = true;
    }

    pub fn is_sealed(&self) -> bool {
        self.sealed
    }

    /// Run `f` with `provider_id` recorded as the owner of what it registers.
    pub fn run_as_provider<T>(&mut self, provider_id: &str, f: impl FnOnce(&mut Self) -> T) -> T {
        let previous = self.current_provider.replace(provider_id.to_string());
        let out = f(self);
        self.current_provider = previous;
        out
    }

    pub fn attr_owner(&self, type_name: &str, sub_type: &str, name: &str) -> Option<&str> {
        self.attr_owners
            .get(&format!("{type_name}.{sub_type}"))
            .and_then(|m| m.get(name))
            .map(String::as_str)
    }

    pub fn common_attr_owner(&self, name: &str) -> Option<&str> {
        self.common_attr_owners.get(name).map(String::as_str)
    }

    fn stamp_attr_owner(&mut self, type_name: &str, sub_type: &str, name: &str) {
        let Some(provider) = self.current_provider.clone() else {
            return;
        };
        self.attr_owners
            .entry(format!("{type_name}.{sub_type}"))
            .or_default()
            .insert(name.to_string(), provider);
    }

    fn check_attr_ownership(
        &self,
        type_name: &str,
        sub_type: &str,
        name: &str,
    ) -> Result<(), MetaError> {
        let Some(claimant) = self.current_provider.as_deref() else {
            return Ok(());
        };
        if let Some(owner) = self.common_attr_owners.get(name)
            && owner != claimant
        {
            return Err(MetaError::code(
                ERR_PROVIDER_ATTR_CONFLICT,
                format!(
                    "Provider \"{claimant}\" declares attribute \"{name}\" on \"{type_name}.{sub_type}\", but provider \"{owner}\" already registers it as a common attribute, which every node type accepts; provider \"{claimant}\" cannot declare it again (ADR-0062)"
                ),
            ));
        }
        let mut related: Vec<&str> = vec![sub_type];
        if sub_type == SUBTYPE_BASE {
            for sub in self.sub_types.get(type_name).into_iter().flatten() {
                if sub != SUBTYPE_BASE {
                    related.push(sub);
                }
            }
        } else if self
            .defs
            .contains_key(&format!("{type_name}.{SUBTYPE_BASE}"))
        {
            related.push(SUBTYPE_BASE);
        }
        for sub in related {
            let Some(owner) = self.attr_owner(type_name, sub, name) else {
                continue;
            };
            if owner == claimant {
                continue;
            }
            if sub == sub_type {
                return Err(MetaError::code(
                    ERR_PROVIDER_ATTR_CONFLICT,
                    format!(
                        "TypeRegistry.extend: attribute \"{name}\" is already declared on \"{type_name}.{sub_type}\" by provider \"{owner}\"; provider \"{claimant}\" cannot declare it again (ADR-0062)"
                    ),
                ));
            }
            return Err(MetaError::code(
                ERR_PROVIDER_ATTR_SHADOW,
                format!(
                    "Provider \"{claimant}\" declares attribute \"{name}\" on \"{type_name}.{sub_type}\", but provider \"{owner}\" already declares it on the related slot \"{type_name}.{sub}\". Two providers may not claim one attribute name on a type and the type it inherits from; give the second provider its own idiomatic name (ADR-0062)."
                ),
            ));
        }
        Ok(())
    }

    fn check_not_sealed(&self, operation: &str) -> Result<(), MetaError> {
        if self.sealed {
            return Err(MetaError::code(
                ERR_REGISTRY_SEALED,
                format!(
                    "TypeRegistry is sealed (ADR-0023): {operation} is not permitted after metamodel bootstrap. Made-up metamodel attributes/types are structurally disallowed — a new metamodel attribute requires a registered provider + human agreement. Downstream apps that need extra vocabulary must compose their own (unsealed) registry."
                ),
            ));
        }
        Ok(())
    }

    fn check_value_type(attr: &AttrSchema, context: &str) -> Result<(), MetaError> {
        if attr.value_type.as_deref() == Some(SUBTYPE_BASE) {
            return Err(plain(format!(
                "{context}: attr \"{}\" declares valueType \"{SUBTYPE_BASE}\", which is not valid for attrs. Use no valueType (omit the field) for a polymorphic/untyped attr.",
                attr.name
            )));
        }
        Ok(())
    }

    /// Register a new `type.subType`. A duplicate is an error.
    pub fn register(&mut self, def: TypeDefinition) -> Result<(), MetaError> {
        let key = def.key();
        self.check_not_sealed(&format!("register(\"{key}\")"))?;
        if self.defs.contains_key(&key) {
            return Err(plain(format!(
                "TypeRegistry: duplicate registration for \"{key}\" (type=\"{}\", subType=\"{}\")",
                def.type_name, def.sub_type
            )));
        }
        for attr in &def.attributes {
            Self::check_value_type(attr, &format!("TypeRegistry.register on \"{key}\""))?;
        }
        for attr in &def.attributes {
            self.check_attr_ownership(&def.type_name, &def.sub_type, &attr.name)?;
        }
        let (type_name, sub_type) = (def.type_name.clone(), def.sub_type.clone());
        let names: Vec<String> = def.attributes.iter().map(|a| a.name.clone()).collect();
        self.defs.insert(key, def);
        self.sub_types
            .entry(type_name.clone())
            .or_default()
            .push(sub_type.clone());
        for name in names {
            self.stamp_attr_owner(&type_name, &sub_type, &name);
        }
        Ok(())
    }

    pub fn find(&self, type_name: &str, sub_type: &str) -> Option<&TypeDefinition> {
        self.defs.get(&format!("{type_name}.{sub_type}"))
    }

    pub fn find_mut(&mut self, type_name: &str, sub_type: &str) -> Option<&mut TypeDefinition> {
        self.defs.get_mut(&format!("{type_name}.{sub_type}"))
    }

    pub fn has(&self, type_name: &str, sub_type: &str) -> bool {
        self.find(type_name, sub_type).is_some()
    }

    /// Every definition, in registration order.
    pub fn all(&self) -> impl Iterator<Item = &TypeDefinition> {
        self.defs.values()
    }

    /// The subtypes registered for `type_name`, in registration order.
    pub fn all_sub_types_of(&self, type_name: &str) -> Vec<String> {
        self.sub_types.get(type_name).cloned().unwrap_or_default()
    }

    pub fn has_type(&self, type_name: &str) -> bool {
        self.sub_types.contains_key(type_name)
    }

    pub fn set_default_sub_type(
        &mut self,
        type_name: &str,
        sub_type: &str,
    ) -> Result<(), MetaError> {
        self.check_not_sealed(&format!("setDefaultSubType(\"{type_name}\")"))?;
        self.default_sub_types
            .insert(type_name.to_string(), sub_type.to_string());
        Ok(())
    }

    pub fn default_sub_type_of(&self, type_name: &str) -> Option<&str> {
        self.default_sub_types.get(type_name).map(String::as_str)
    }

    /// Attributes every node type accepts (the documentation provider's set).
    pub fn common_attrs(&self) -> &[AttrSchema] {
        &self.common_attrs
    }

    pub fn common_attr(&self, name: &str) -> Option<&AttrSchema> {
        self.common_attrs.iter().find(|a| a.name == name)
    }

    pub fn register_common_attrs(&mut self, attrs: Vec<AttrSchema>) -> Result<(), MetaError> {
        self.check_not_sealed("registerCommonAttrs")?;
        if let Some(claimant) = self.current_provider.as_deref() {
            for attr in &attrs {
                if let Some(owner) = self.common_attr_owners.get(&attr.name)
                    && owner != claimant
                {
                    return Err(MetaError::code(
                        ERR_PROVIDER_ATTR_CONFLICT,
                        format!(
                            "Provider \"{claimant}\" registers common attribute \"{}\", but provider \"{owner}\" already registers it as a common attribute; provider \"{claimant}\" cannot declare it again (ADR-0062)",
                            attr.name
                        ),
                    ));
                }
                for (slot, owners) in &self.attr_owners {
                    if let Some(slot_owner) = owners.get(&attr.name)
                        && slot_owner != claimant
                    {
                        return Err(MetaError::code(
                            ERR_PROVIDER_ATTR_CONFLICT,
                            format!(
                                "Provider \"{claimant}\" registers common attribute \"{}\", which every node type accepts, but provider \"{slot_owner}\" already declares it on \"{slot}\"; provider \"{claimant}\" cannot declare it again (ADR-0062)",
                                attr.name
                            ),
                        ));
                    }
                }
            }
        }
        for attr in attrs {
            Self::check_value_type(&attr, "TypeRegistry.registerCommonAttrs")?;
            if attr.required {
                return Err(MetaError::code(
                    ERR_EXTEND_REQUIRED_ATTR,
                    format!(
                        "TypeRegistry.registerCommonAttrs: attribute \"{}\" is REQUIRED. A common attr is projected onto every registered type, so a required one would vanish from all of them whenever its provider is composed out. Common attrs must be optional (ADR-0050).",
                        attr.name
                    ),
                ));
            }
            if self.common_attrs.iter().any(|a| a.name == attr.name) {
                continue;
            }
            if let Some(claimant) = self.current_provider.clone() {
                self.common_attr_owners.insert(attr.name.clone(), claimant);
            }
            self.common_attrs.push(attr);
        }
        Ok(())
    }

    /// Add optional attributes (and child rules) to a type another provider owns.
    pub fn extend(
        &mut self,
        type_name: &str,
        sub_type: &str,
        attributes: Vec<AttrSchema>,
        child_rules: Vec<ChildRule>,
    ) -> Result<(), MetaError> {
        self.check_not_sealed(&format!("extend(\"{type_name}.{sub_type}\")"))?;
        if !self.has(type_name, sub_type) {
            return Err(plain(format!(
                "TypeRegistry.extend: no registered type \"{type_name}.{sub_type}\" to extend"
            )));
        }
        for attr in attributes {
            Self::check_value_type(
                &attr,
                &format!("TypeRegistry.extend on \"{type_name}.{sub_type}\""),
            )?;
            let exists = self
                .find(type_name, sub_type)
                .is_some_and(|d| d.attr(&attr.name).is_some());
            self.check_attr_ownership(type_name, sub_type, &attr.name)?;
            if exists {
                return Err(MetaError::code(
                    ERR_PROVIDER_ATTR_CONFLICT,
                    format!(
                        "TypeRegistry.extend: attribute \"{}\" is already declared on \"{type_name}.{sub_type}\"",
                        attr.name
                    ),
                ));
            }
            if attr.required {
                return Err(MetaError::code(
                    ERR_EXTEND_REQUIRED_ATTR,
                    format!(
                        "TypeRegistry.extend: attribute \"{}\" being added to \"{type_name}.{sub_type}\" is REQUIRED. A provider may only project OPTIONAL attributes onto a type it does not own — a required attr registered this way disappears, silently, whenever that provider is composed out. Declare it with the type instead (ADR-0050).",
                        attr.name
                    ),
                ));
            }
            let name = attr.name.clone();
            if let Some(def) = self.find_mut(type_name, sub_type) {
                def.attributes.push(attr);
            }
            self.stamp_attr_owner(type_name, sub_type, &name);
        }
        if let Some(def) = self.find_mut(type_name, sub_type) {
            def.child_rules.extend(child_rules);
        }
        Ok(())
    }
}
