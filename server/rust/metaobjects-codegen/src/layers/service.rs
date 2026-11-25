//! The service walk: the operations a package's service crate holds (each stored entity's
//! derived operations, its lifecycle commands, the package's declared operations) with their
//! permission points, moves and stamps. The `service` generator renders it, and the
//! `service-routes` transport mounts the same walk, so the two agree by construction and an
//! owned copy of either keeps calling it.

use std::collections::{BTreeMap, BTreeSet};

use metaobjects::config::{RulesLifecycleCreate, RulesPermissionNames};
use metaobjects::node::{NodeId, Tree};
use metaobjects::rules_names::{OperationKind, RulesNamesOperation, rules_names_of};
use metaobjects::validate::util::ObjectIndex;

use crate::generator::{ERR_NAME_COLLISION, ERR_UNSUPPORTED, GenContext, GenError};
use crate::layers::rules::{EntityNames, RULES_SUFFIX, RulesCrate, crate_of};
use crate::layers::store::{StoredCrate, StoredEntity, stored_crates};
use crate::names::{crate_name, pascal, snake, type_ident};
use crate::plan::{Plan, Presence, StructPlan};

pub use crate::plan::{CONTRACT_SUFFIX, SERVICE_CRATE, SERVICE_SUFFIX};

const ATTR_INPUT_REF: &str = "inputRef";
const ATTR_OUTPUT_REF: &str = "outputRef";
const ATTR_MANY: &str = "many";
const ATTR_PUBLIC: &str = "public";
const ATTR_PERMISSION: &str = "permission";
const ATTR_AUTO_SET: &str = "autoSet";
const AUTO_SET_ON_UPDATE: &str = "onUpdate";

// ---- the walk --------------------------------------------------------------------------------

/// A transition's derived command on an entity.
pub struct ServiceCommand {
    /// The method: `<transition>_<type>`.
    pub function: String,
    /// The operation name events carry: `<transition><Entity>`.
    pub operation: String,
    pub transition: ServiceMove,
    /// The permission variant it asks about; `None` when the transition is `@public`.
    pub permission: Option<String>,
}

/// One move of a lifecycle, by the rules crate's names.
pub struct ServiceMove {
    pub name: String,
    /// The lifecycle field's wire name and its member on the row.
    pub field: String,
    pub ident: String,
    /// `<rules crate>::<entity>::<field>::Transition::<Variant>`.
    pub path: String,
    /// The `@condition`, as JSON text, when the move has one.
    pub condition: Option<String>,
}

/// One lifecycle of an entity, for the create and update checks.
pub struct ServiceLifecycle {
    pub field: String,
    pub ident: String,
    /// `<rules crate>::<entity>::<field>`, the module holding `INITIAL`.
    pub module: String,
    /// How the create body carries the field.
    pub create: Presence,
    /// Whether the patch carries it.
    pub patch: bool,
}

/// An `@autoSet` timestamp the service stamps (ADR-0045).
pub struct ServiceStamp {
    pub ident: String,
    /// `onUpdate`: stamped by an update as well as a create.
    pub on_update: bool,
    pub local_time: bool,
    /// Whether the create body carries it as an `Option`, and the patch as an `Option<Option>`.
    pub create_optional: bool,
    pub patch_optional: bool,
    pub patch: bool,
}

/// One stored entity's operations.
pub struct ServiceEntity {
    pub store: StoredEntity,
    /// The store crate's module: `<store crate>::<module>`.
    pub store_module: String,
    /// The rules crate's module for the entity, when it has a lifecycle: `<rules crate>::<module>`.
    pub rules_module: Option<String>,
    pub lifecycles: Vec<ServiceLifecycle>,
    pub commands: Vec<ServiceCommand>,
    pub stamps: Vec<ServiceStamp>,
}

impl ServiceEntity {
    /// Whether the entity is written, not only read.
    pub fn writable(&self) -> bool {
        !self.store.read_only
    }

    /// The entity's part of a hook variant's name: its Rust type's name.
    pub fn variant(&self) -> &str {
        let row = &self.store.row;
        row.rsplit("::").next().unwrap_or(row)
    }
}

/// One declared operation.
pub struct ServiceOperation {
    pub names: RulesNamesOperation,
    /// The method: the name in snake case.
    pub function: String,
    /// The contract's type stem: the name in pascal case.
    pub stem: String,
    /// The index of its target in [`ServicePackage::entities`], when it has one.
    pub target: Option<usize>,
    pub keyed: bool,
    pub has_input: bool,
    /// The input's member that borrows the target's key, and whether it is an `Option`.
    pub input_key: Option<(String, bool)>,
    pub has_output: bool,
    /// The command answers its target's row, as the command left it.
    pub output_is_row: bool,
    pub many: bool,
    pub moves: Vec<ServiceMove>,
    /// The permission variant it asks about; `None` when it is `@public`.
    pub permission: Option<String>,
}

impl ServiceOperation {
    pub fn command(&self) -> bool {
        self.names.kind == OperationKind::Command
    }
}

/// One package's service crate.
pub struct ServicePackage {
    pub package: String,
    pub name: String,
    pub model: String,
    pub store: String,
    /// The rules crate, when the package has a lifecycle or an operation.
    pub rules: Option<String>,
    /// The contract crate, when it declares an operation.
    pub contract: Option<String>,
    /// `PurchasingService`.
    pub service: String,
    /// `Purchasing`: the stem of every trait and of the error.
    pub stem: String,
    pub entities: Vec<ServiceEntity>,
    pub operations: Vec<ServiceOperation>,
    pub has_policy: bool,
    pub deps: BTreeSet<String>,
    pub create_initial: bool,
    /// `api.pagination`: the default page and the largest, when the project sets them.
    pub pagination: Option<(u64, u64)>,
}

impl ServicePackage {
    /// Whether the package declares operations, whose bodies a `Bodies` trait holds.
    pub fn has_bodies(&self) -> bool {
        !self.operations.is_empty()
    }

    /// The type parameters of the service, in order.
    pub fn params(&self) -> Vec<&'static str> {
        let mut p = vec!["D", "A"];
        if self.has_policy {
            p.push("P");
        }
        if self.has_bodies() {
            p.push("B");
        }
        p.extend(["H", "E"]);
        p
    }

    /// The type parameters of the service, joined: `D, A, H, E`.
    pub fn generics(&self) -> String {
        self.params().join(", ")
    }

    /// The `where` bounds every operation's `impl` block takes.
    pub fn bounds(&self) -> Vec<String> {
        let stem = &self.stem;
        let mut b = vec!["D: meta_service::Db".to_string(), "A: Sync".to_string()];
        if self.has_policy {
            b.push(format!("P: crate::{stem}Policy<A, D::Conn>"));
        }
        if self.has_bodies() {
            b.push(format!("B: crate::{stem}Bodies<A, D::Conn>"));
        }
        b.push(format!("H: crate::{stem}Hooks<A, D::Conn>"));
        b.push(format!("E: crate::{stem}Events<A, D::Conn>"));
        b
    }
}

/// The service type of a package: its last segment in pascal case plus `Service`
/// (`acme::purchasing` is `PurchasingService`); the root package's is `ModelService`.
pub fn service_type_name(package: &str) -> String {
    let last = package.split("::").filter(|s| !s.is_empty()).last();
    format!(
        "{}Service",
        last.map_or("Model".to_string(), |l| type_ident(&pascal(l)))
    )
}

fn unsupported(message: String) -> GenError {
    GenError::new(ERR_UNSUPPORTED, message)
}

/// A point with no `@permission` that is not `@public` asks about a derived name, which
/// `rules.permissions.names: require` refuses.
fn require_declared(
    tree: &Tree,
    require: bool,
    node: NodeId,
    what: &str,
    derived: Option<&String>,
) -> Result<(), GenError> {
    let public = tree.attr(node, ATTR_PUBLIC).and_then(|v| v.as_bool()) == Some(true);
    if require && !public && tree.attr(node, ATTR_PERMISSION).is_none() {
        return Err(unsupported(format!(
            "service: {what} declares no @permission and is not @public, and rules.permissions.names is \"require\"; declare its permission (it would derive {:?})",
            derived.map_or("", |s| s.as_str())
        )));
    }
    Ok(())
}

fn struct_of(plan: &Plan, node: NodeId) -> Option<&StructPlan> {
    plan.structs.iter().find(|s| s.node == node)
}

fn moves_of(
    rules: &RulesCrate,
    rules_crate: &str,
    names: &EntityNames,
    s: &StructPlan,
    wanted: &dyn Fn(&str) -> bool,
) -> Vec<ServiceMove> {
    let mut out = Vec::new();
    let _ = rules;
    for l in &names.lifecycles {
        let ident = s
            .fields
            .iter()
            .find(|f| f.wire == l.names.field)
            .map_or_else(|| snake(&l.names.field), |f| f.ident.clone());
        for (t, variant) in l.names.transitions.iter().zip(&l.transitions) {
            if !wanted(&t.name) {
                continue;
            }
            out.push(ServiceMove {
                name: t.name.clone(),
                field: l.names.field.clone(),
                ident: ident.clone(),
                path: format!(
                    "{rules_crate}::{}::{}::Transition::{variant}",
                    names.module, l.module
                ),
                condition: t.condition.as_ref().map(|c| c.to_string()),
            });
        }
    }
    out
}

/// The service crates of the run, one per package with a stored entity, in crate order.
pub fn service_packages(ctx: &GenContext<'_>) -> Result<Vec<ServicePackage>, GenError> {
    let tree = ctx.tree;
    let plan = Plan::of(ctx)?;
    let index = ObjectIndex::build(tree, ctx.root);
    let settings = &ctx.collection.config.rules;
    let require = settings.permission_names == RulesPermissionNames::Require;
    let mut rules: BTreeMap<String, RulesCrate> = BTreeMap::new();
    for p in rules_names_of(tree, ctx.root, &index, settings, &|_| true) {
        rules.insert(crate_name(&p.package), crate_of(&plan, p)?);
    }

    let mut out = Vec::new();
    for StoredCrate {
        name: store,
        model,
        package,
        entities,
        mut deps,
    } in stored_crates(ctx)?
    {
        let rc = rules.get(&model);
        let rules_crate = format!("{model}{RULES_SUFFIX}");
        let mut list = Vec::new();
        for e in entities {
            let s = struct_of(&plan, e.node)
                .ok_or_else(|| unsupported(format!("service: {} is not planned", e.object)))?;
            let names = rc.and_then(|r| r.entities.iter().find(|n| n.names.node == e.node));
            let mut lifecycles = Vec::new();
            let mut commands = Vec::new();
            if let (Some(r), Some(n)) = (rc, names) {
                for l in &n.lifecycles {
                    let Some(f) = s.fields.iter().find(|f| f.wire == l.names.field) else {
                        continue;
                    };
                    lifecycles.push(ServiceLifecycle {
                        field: f.wire.clone(),
                        ident: f.ident.clone(),
                        module: format!("{rules_crate}::{}::{}", n.module, l.module),
                        create: f.create,
                        patch: f.patch,
                    });
                }
                if e.key.is_some() && !e.read_only {
                    for c in &n.names.commands {
                        let what = format!("transition {}.{}.{}", e.object, c.lifecycle, c.name);
                        let t = n
                            .lifecycles
                            .iter()
                            .flat_map(|l| l.names.transitions.iter())
                            .find(|t| t.name == c.name)
                            .ok_or_else(|| unsupported(format!("service: {what} is not found")))?;
                        require_declared(tree, require, t.node, &what, c.permission.as_ref())?;
                        let m = moves_of(r, &rules_crate, n, s, &|name| name == c.name)
                            .into_iter()
                            .next()
                            .ok_or_else(|| unsupported(format!("service: {what} has no move")))?;
                        commands.push(ServiceCommand {
                            function: format!("{}_{}", snake(&c.name), e.module),
                            operation: format!("{}{}", c.name, e.object),
                            transition: m,
                            permission: c.permission.as_ref().map(|p| r.permission(p).to_string()),
                        });
                    }
                }
            }
            let rules_module = names
                .filter(|n| !n.lifecycles.is_empty())
                .map(|n| format!("{rules_crate}::{}", n.module));
            let stamps = s
                .fields
                .iter()
                .filter_map(|f| {
                    let mode = tree.attr(f.node, ATTR_AUTO_SET)?.as_str()?;
                    (f.create != Presence::Absent).then(|| ServiceStamp {
                        ident: f.ident.clone(),
                        on_update: mode == AUTO_SET_ON_UPDATE,
                        local_time: f.local_time,
                        create_optional: f.create == Presence::Optional,
                        patch_optional: f.optional,
                        patch: f.patch,
                    })
                })
                .collect();
            list.push(ServiceEntity {
                stamps,
                rules_module,
                store_module: format!("{store}::{}", e.module),
                store: e,
                lifecycles,
                commands,
            });
        }

        let mut operations = Vec::new();
        if let Some(r) = rc {
            for o in &r.operations {
                let target = match o.target {
                    Some(t) => match list.iter().position(|e| e.store.node == t) {
                        Some(i) => Some(i),
                        // An operation on an entity the service does not cover has no shell.
                        None => continue,
                    },
                    None => None,
                };
                let what = format!("operation {}", o.name);
                require_declared(tree, require, o.node, &what, o.permission.as_ref())?;
                let keyed = o.keyed && target.is_some_and(|i| list[i].store.key.is_some());
                if !o.transitions.is_empty() && !keyed {
                    return Err(unsupported(format!(
                        "service: command {} lists @transitions but addresses no row by key, so it has no row to move",
                        o.name
                    )));
                }
                let input = index.ref_target(tree, o.node, ATTR_INPUT_REF);
                let output = index.ref_target(tree, o.node, ATTR_OUTPUT_REF);
                let input_key = match (&o.input_key_field, input.and_then(|i| struct_of(&plan, i)))
                {
                    (Some(field), Some(v)) if keyed => v
                        .fields
                        .iter()
                        .find(|f| &f.wire == field)
                        .map(|f| (f.ident.clone(), f.optional)),
                    _ => None,
                };
                let command = o.kind == OperationKind::Command;
                let moves = match target {
                    Some(i) if command => {
                        let e = &list[i];
                        let names = r.entities.iter().find(|n| n.names.node == e.store.node);
                        match (names, struct_of(&plan, e.store.node)) {
                            (Some(n), Some(s)) => moves_of(r, &rules_crate, n, s, &|t| {
                                o.transitions.iter().any(|x| x == t)
                            }),
                            _ => Vec::new(),
                        }
                    }
                    _ => Vec::new(),
                };
                operations.push(ServiceOperation {
                    function: snake(&o.name),
                    stem: type_ident(&pascal(&o.name)),
                    target,
                    keyed,
                    has_input: input.is_some(),
                    input_key,
                    has_output: output.is_some(),
                    output_is_row: command
                        && target.is_some_and(|i| output == Some(list[i].store.node)),
                    many: tree.attr(o.node, ATTR_MANY).and_then(|v| v.as_bool()) == Some(true),
                    moves,
                    permission: o.permission.as_ref().map(|p| r.permission(p).to_string()),
                    names: o.clone(),
                });
            }
        }

        // Every method of the service shares one namespace.
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        let mut claim = |f: &str, what: String| -> Result<(), GenError> {
            if let Some(prev) = seen.insert(f.to_string(), what.clone()) {
                return Err(GenError::new(
                    ERR_NAME_COLLISION,
                    format!("service: {prev} and {what} would both be the method {f}"),
                ));
            }
            Ok(())
        };
        for e in &list {
            let m = &e.store.module;
            for verb in entity_verbs(e) {
                claim(&format!("{verb}_{m}"), format!("{} {verb}", e.store.object))?;
            }
            for t in &e.store.traversals {
                claim(
                    &format!("{}_{m}", t.function),
                    format!("{}.{}", e.store.object, t.relation),
                )?;
            }
            for c in &e.commands {
                claim(
                    &c.function,
                    format!("{} command {}", e.store.object, c.transition.name),
                )?;
            }
        }
        for o in &operations {
            claim(&o.function, format!("operation {}", o.names.name))?;
        }

        let has_policy = list
            .iter()
            .any(|e| e.commands.iter().any(|c| c.permission.is_some()))
            || operations.iter().any(|o| o.permission.is_some());
        let has_rules = !list.iter().all(|e| e.lifecycles.is_empty()) || has_policy;
        if has_rules {
            deps.insert(rules_crate.clone());
        }
        let contract = (!operations.is_empty()).then(|| format!("{model}{CONTRACT_SUFFIX}"));
        if let Some(c) = &contract {
            deps.insert(c.clone());
        }
        let contract = contract.map(|c| format!("{c}::operations"));
        deps.insert(store.clone());
        let service = service_type_name(&package);
        out.push(ServicePackage {
            name: format!("{model}{SERVICE_SUFFIX}"),
            stem: service.trim_end_matches("Service").to_string(),
            service,
            package,
            model,
            store,
            rules: has_rules.then_some(rules_crate),
            contract,
            entities: list,
            operations,
            has_policy,
            deps,
            create_initial: settings.lifecycle_create == RulesLifecycleCreate::Initial,
            pagination: ctx
                .collection
                .config
                .api_pagination()
                .map(|p| (u64::from(p.default_limit), u64::from(p.max_limit))),
        });
    }
    Ok(out)
}

/// The derived operations of an entity, in order.
pub fn entity_verbs(e: &ServiceEntity) -> Vec<&'static str> {
    let keyed = e.store.key.is_some();
    let mut v = vec!["list"];
    if keyed {
        v.push("get");
    }
    if e.writable() {
        v.push("create");
        if keyed {
            v.extend(["update", "delete"]);
        }
    }
    v
}
