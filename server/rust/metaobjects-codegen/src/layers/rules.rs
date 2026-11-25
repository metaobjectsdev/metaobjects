//! The rules-names walk in Rust names: each package's lifecycles, states, operations,
//! permissions and business errors, as the `rules-names` generator writes them and the
//! `service` generator calls them.

use std::collections::{BTreeMap, BTreeSet};

use metaobjects::rules_names::{
    RulesNamesEntity, RulesNamesLifecycle, RulesNamesOperation, RulesNamesPackage,
};

use crate::generator::{ERR_NAME_COLLISION, ERR_UNSUPPORTED, GenError};
use crate::names::{module_name, pascal, type_ident};
use crate::plan::{EnumPlan, Plan, Ty};

/// The suffix of the rules crate of a package: `shop`'s names are in `shop_rules`.
pub const RULES_SUFFIX: &str = "_rules";

/// One lifecycle, with the Rust names of its state type and states.
pub struct LifecycleNames {
    pub names: RulesNamesLifecycle,
    /// The lifecycle's module in its entity's: the field in snake case.
    pub module: String,
    /// The model's enum for the field: `acme_shop::OrderStatus`.
    pub state_type: String,
    /// Each state's variant, by the state's wire symbol.
    pub variants: BTreeMap<String, String>,
    /// Each transition's variant, in model order.
    pub transitions: Vec<String>,
}

/// One entity of a rules crate.
pub struct EntityNames {
    pub names: RulesNamesEntity,
    /// The entity's module: its name in snake case.
    pub module: String,
    pub lifecycles: Vec<LifecycleNames>,
    /// Each command's variant, in model order.
    pub commands: Vec<String>,
}

/// One package's rules crate.
pub struct RulesCrate {
    /// The package (`acme::shop`), or `""` for a model with none.
    pub package: String,
    /// The model crate that holds the state enums, when an entity has a lifecycle.
    pub model_crate: Option<String>,
    pub entities: Vec<EntityNames>,
    pub operations: Vec<RulesNamesOperation>,
    /// Each operation's variant, in model order.
    pub operation_variants: Vec<String>,
    /// Each permission's dotted name with its variant, sorted by name.
    pub permissions: Vec<(String, String)>,
    /// Each business error's code with its variant, sorted by code.
    pub errors: Vec<(String, String)>,
}

impl RulesCrate {
    /// The variant of the permission `name`.
    pub fn permission(&self, name: &str) -> &str {
        self.permissions
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
            .expect("every permission a point asks about is in the package's list")
    }

    /// The variant of the business error `code`.
    pub fn error(&self, code: &str) -> &str {
        self.errors
            .iter()
            .find(|(c, _)| c == code)
            .map(|(_, v)| v.as_str())
            .expect("every business error a command declares is in the package's list")
    }
}

/// `acme.shop.Order.submit` becomes `AcmeShopOrderSubmit`: each dotted (or `::`) segment in
/// pascal case.
pub fn permission_variant(name: &str) -> String {
    let joined: String = name
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .map(pascal)
        .collect();
    type_ident(&joined)
}

/// Each name's variant, refusing two names that would take one.
fn variants<'a>(
    what: &str,
    names: impl IntoIterator<Item = &'a str>,
    to_variant: impl Fn(&str) -> String,
) -> Result<Vec<(String, String)>, GenError> {
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    let mut out = Vec::new();
    for name in names {
        let v = to_variant(name);
        if let Some(other) = seen.insert(v.clone(), name.to_string()) {
            if other != name {
                return Err(GenError::new(
                    ERR_NAME_COLLISION,
                    format!("{what} {other:?} and {name:?} would both be the Rust variant {v}"),
                ));
            }
            continue;
        }
        out.push((name.to_string(), v));
    }
    Ok(out)
}

fn variant_list<'a>(
    what: &str,
    names: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<String>, GenError> {
    Ok(variants(what, names, type_ident)?
        .into_iter()
        .map(|(_, v)| v)
        .collect())
}

/// The model's enum for the lifecycle field `field` of the planned entity `entity`.
fn state_enum<'p>(
    plan: &'p Plan,
    entity: &RulesNamesEntity,
    field: &str,
) -> Result<(String, &'p str, &'p EnumPlan), GenError> {
    let what = format!("{}.{field}", entity.name);
    let s = plan
        .structs
        .iter()
        .find(|s| s.node == entity.node)
        .ok_or_else(|| GenError::new(ERR_UNSUPPORTED, format!("{what}: no planned entity")))?;
    let Some(Ty::Ref(r)) = s.fields.iter().find(|f| f.wire == field).map(|f| &f.ty) else {
        return Err(GenError::new(
            ERR_UNSUPPORTED,
            format!("{what} is a lifecycle the entity generator does not plan as an enum"),
        ));
    };
    let owner = plan.crates.get(&r.crate_name);
    let found = s
        .enums
        .iter()
        .find(|e| e.type_name == r.type_name)
        .or_else(|| {
            owner.and_then(|c| {
                c.shared_enums
                    .iter()
                    .map(|(_, e)| e)
                    .find(|e| e.type_name == r.type_name)
            })
        });
    match found {
        Some(e) => Ok((r.crate_name.clone(), r.type_name.as_str(), e)),
        None => Err(GenError::new(
            ERR_UNSUPPORTED,
            format!("{what}: the enum {} is not planned", r.type_name),
        )),
    }
}

pub fn crate_of(plan: &Plan, pkg: RulesNamesPackage) -> Result<RulesCrate, GenError> {
    let mut model_crate = None;
    let mut entities = Vec::new();
    let mut modules: BTreeSet<String> = BTreeSet::new();
    for e in pkg.entities {
        // An abstract entity has no type of its own; its concrete descendants carry its
        // lifecycles.
        if !plan.structs.iter().any(|s| s.node == e.node) {
            continue;
        }
        let module = module_name(&e.name);
        if !modules.insert(module.clone()) {
            return Err(GenError::new(
                ERR_NAME_COLLISION,
                format!(
                    "two entities of {:?} would both be the module {module}",
                    pkg.package
                ),
            ));
        }
        let mut lifecycles = Vec::new();
        for l in &e.lifecycles {
            let (krate, type_name, plan_enum) = state_enum(plan, &e, &l.field)?;
            model_crate = Some(krate.clone());
            let variants = plan_enum
                .members
                .iter()
                .map(|m| (m.wire.clone(), m.variant.clone()))
                .collect();
            lifecycles.push(LifecycleNames {
                module: module_name(&l.field),
                state_type: format!("{krate}::{type_name}"),
                variants,
                transitions: variant_list(
                    "the transitions",
                    l.transitions.iter().map(|t| t.name.as_str()),
                )?,
                names: l.clone(),
            });
        }
        let commands = variant_list("the commands", e.commands.iter().map(|c| c.name.as_str()))?;
        entities.push(EntityNames {
            module,
            lifecycles,
            commands,
            names: e,
        });
    }
    let operation_variants = variant_list(
        "the operations",
        pkg.operations.iter().map(|o| o.name.as_str()),
    )?;
    let permissions = variants(
        "the permissions",
        pkg.permissions.iter().map(String::as_str),
        permission_variant,
    )?;
    let errors = variants(
        "the business errors",
        pkg.errors.iter().map(String::as_str),
        type_ident,
    )?;
    Ok(RulesCrate {
        package: pkg.package,
        model_crate,
        entities,
        operations: pkg.operations,
        operation_variants,
        permissions,
        errors,
    })
}
