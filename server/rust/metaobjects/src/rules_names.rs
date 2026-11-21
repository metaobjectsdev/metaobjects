//! The rules names of a model, one record per metadata package (ADR-0067 §1, layer 0; ADR-0066).
//!
//! The names layer is the tether between the model and hand-written code: a body, a policy or a
//! grant table that names a state, a transition, a permission or an error code through the
//! generated constants stops compiling when the model renames it. This walk collects what the
//! model DERIVES as well as what it declares, from the same functions `cargo meta verify`'s rules
//! gate uses ([`crate::rules_check`]), so a generated constant and a verify message cannot name
//! two different permissions. It is a port of the TypeScript reference walk (`rules-walk.ts`).
//!
//! It is engine, not emit: the `rules-names` generator renders these records, and an owned copy
//! of that generator keeps calling this walk, so what the model means stays packaged while the
//! file's shape is the adopter's.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::config::RulesSettings;
use crate::node::{NodeId, Tree};
use crate::rules_check::{
    claimed_transitions, derived_permission_name, derives_command, entities, lifecycle_is_live,
    lifecycles_of, operation_target, operations, terminal_states, transition_from,
};
use crate::validate::Env;
use crate::validate::rules::{
    RESERVED_ERROR_CODES, entity_transitions, is_true, str_attr, string_list,
};
use crate::validate::util::ObjectIndex;

const A_TO: &str = "to";
const A_PERMISSION: &str = "permission";
const A_PUBLIC: &str = "public";
const A_TRANSITIONS: &str = "transitions";
const A_ERRORS: &str = "errors";
const SUB_COMMAND: &str = "command";

/// How many of [`RESERVED_ERROR_CODES`] the enforcing shell answers on its own (ADR-0066 §6):
/// the first five. The rest belong to the API contract's transport.
const SHELL_CODE_COUNT: usize = 5;

/// The wire codes the enforcing shell answers with on its own (ADR-0066 §6).
pub fn shell_error_codes() -> &'static [&'static str] {
    &RESERVED_ERROR_CODES[..SHELL_CODE_COUNT]
}

/// The wire codes the REST contract's transport answers with: the reserved codes the shell does
/// not answer.
pub fn contract_error_codes() -> &'static [&'static str] {
    &RESERVED_ERROR_CODES[SHELL_CODE_COUNT..]
}

/// One transition of a lifecycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesTransition {
    pub name: String,
    pub from: Vec<String>,
    pub to: String,
}

/// One lifecycle of an entity: an enum field with at least one transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesLifecycle {
    /// The lifecycle's field.
    pub field: String,
    /// The field's node, for a generator that needs the field's own type.
    pub field_node: NodeId,
    pub states: Vec<String>,
    /// The enum's `@default`; the loader refuses a lifecycle without one.
    pub initial: String,
    pub terminal: Vec<String>,
    pub transitions: Vec<RulesNamesTransition>,
}

/// A command derived from a transition (ADR-0066 §2): it takes the key and makes the transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesCommand {
    /// The command's name, which is the transition's.
    pub name: String,
    /// The field of the lifecycle the transition belongs to.
    pub lifecycle: String,
    /// The permission it asks the policy about; `None` when the transition is `@public`.
    pub permission: Option<String>,
}

/// An entity's lifecycles and derived commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesEntity {
    pub name: String,
    pub node: NodeId,
    pub lifecycles: Vec<RulesNamesLifecycle>,
    /// Empty for an abstract entity or one with no source, which derive no command.
    pub commands: Vec<RulesNamesCommand>,
}

/// Whether a declared operation changes state or only reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationKind {
    Command,
    Query,
}

impl OperationKind {
    /// The word the model uses: the operation's subtype.
    pub fn as_str(self) -> &'static str {
        match self {
            OperationKind::Command => "command",
            OperationKind::Query => "query",
        }
    }
}

/// A declared operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesOperation {
    pub name: String,
    pub node: NodeId,
    pub kind: OperationKind,
    /// The permission it asks the policy about; `None` when it is `@public`.
    pub permission: Option<String>,
    /// The transitions a command may make (`@transitions`).
    pub transitions: Vec<String>,
    /// The business errors a command's body may return (`@errors`), in declaration order.
    pub errors: Vec<String>,
    /// The entity it acts on, declared or derived, when it has one.
    pub target: Option<NodeId>,
}

/// The rules names of one metadata package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesNamesPackage {
    /// The package (`acme::shop`), or `""` for a model with none.
    pub package: String,
    /// Entities of the package with at least one lifecycle, in model order.
    pub entities: Vec<RulesNamesEntity>,
    /// The package's declared operations, once each, in model order.
    pub operations: Vec<RulesNamesOperation>,
    /// Every permission a point of the package asks about, sorted and once each.
    pub permissions: Vec<String>,
    /// Every business error the package's commands declare, sorted and once each.
    pub errors: Vec<String>,
}

fn strings(tree: &Tree, node: NodeId, attr: &str) -> Vec<String> {
    string_list(tree, node, attr)
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn package_of(tree: &Tree, node: NodeId) -> String {
    tree.effective_package(tree.top_level_of(node))
}

/// The permission a declared operation asks the policy about: its `@permission`, else the
/// derived `<package>.<operation>`. `None` for a `@public` operation, which asks about none.
pub fn operation_permission(tree: &Tree, op: NodeId) -> Option<String> {
    point_permission(tree, op, op, &tree.node(op).name)
}

/// The permission a transition's derived command on `entity` asks about: the transition's
/// `@permission`, else the derived `<package>.<Entity>.<transition>` with the concrete
/// entity's package. `None` for a `@public` transition.
pub fn command_permission(tree: &Tree, entity: NodeId, t: NodeId) -> Option<String> {
    let path = format!("{}.{}", tree.node(entity).name, tree.node(t).name);
    point_permission(tree, t, entity, &path)
}

fn point_permission(tree: &Tree, point: NodeId, owner: NodeId, path: &str) -> Option<String> {
    if is_true(tree, point, A_PUBLIC) {
        return None;
    }
    match tree.attr(point, A_PERMISSION) {
        Some(Value::String(p)) => Some(p.clone()),
        _ => Some(derived_permission_name(tree, owner, path)),
    }
}

/// The rules names of every package that declares a lifecycle or an operation, sorted by
/// package. A package that declares neither has no record, so a model with no rules vocabulary
/// yields nothing. `matches` narrows which entities are walked (a run limited to some
/// entities); an operation is kept when its target entity matches or it has none.
pub fn rules_names_of(
    tree: &Tree,
    root: NodeId,
    objects: &ObjectIndex,
    settings: &RulesSettings,
    matches: &dyn Fn(NodeId) -> bool,
) -> Vec<RulesNamesPackage> {
    let env = Env { tree, objects };
    let claimed = claimed_transitions(&env, root);
    let mut by_package: BTreeMap<String, (Vec<RulesNamesEntity>, Vec<RulesNamesOperation>)> =
        BTreeMap::new();

    for entity in entities(tree, root) {
        if !matches(entity) {
            continue;
        }
        let lifecycles = lifecycles_of(tree, entity);
        if lifecycles.is_empty() {
            continue;
        }
        let mut lifecycle_of: Vec<(NodeId, String)> = Vec::new();
        let names: Vec<RulesNamesLifecycle> = lifecycles
            .iter()
            .map(|l| {
                let field = tree.node(l.field).name.clone();
                for &t in &l.transitions {
                    lifecycle_of.push((t, field.clone()));
                }
                RulesNamesLifecycle {
                    field,
                    field_node: l.field,
                    states: l.states.iter().map(|s| s.to_string()).collect(),
                    initial: l.initial.unwrap_or_default().to_string(),
                    terminal: terminal_states(tree, l)
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    transitions: l
                        .transitions
                        .iter()
                        .map(|&t| RulesNamesTransition {
                            name: tree.node(t).name.clone(),
                            from: transition_from(tree, t)
                                .iter()
                                .map(|s| s.to_string())
                                .collect(),
                            to: str_attr(tree, t, A_TO).unwrap_or_default().to_string(),
                        })
                        .collect(),
                }
            })
            .collect();
        let live = !tree.node(entity).is_abstract && lifecycle_is_live(tree, entity);
        let commands = if live {
            entity_transitions(tree, entity)
                .into_iter()
                .filter(|&t| derives_command(tree, &claimed, settings, entity, t))
                .map(|t| RulesNamesCommand {
                    name: tree.node(t).name.clone(),
                    lifecycle: lifecycle_of
                        .iter()
                        .find(|(n, _)| *n == t)
                        .map(|(_, f)| f.clone())
                        .unwrap_or_default(),
                    permission: command_permission(tree, entity, t),
                })
                .collect()
        } else {
            Vec::new()
        };
        by_package
            .entry(package_of(tree, entity))
            .or_default()
            .0
            .push(RulesNamesEntity {
                name: tree.node(entity).name.clone(),
                node: entity,
                lifecycles: names,
                commands,
            });
    }

    // One operation declared identically by two APIs (a versioned API) is one operation (O6),
    // so it is listed once.
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for op in operations(tree, root) {
        let target = operation_target(&env, op);
        if target.is_some_and(|t| !matches(t)) {
            continue;
        }
        let pkg = package_of(tree, op);
        let n = tree.node(op);
        if !seen.insert((pkg.clone(), n.name.to_lowercase())) {
            continue;
        }
        let kind = if n.sub_type == SUB_COMMAND {
            OperationKind::Command
        } else {
            OperationKind::Query
        };
        let command = kind == OperationKind::Command;
        by_package
            .entry(pkg)
            .or_default()
            .1
            .push(RulesNamesOperation {
                name: n.name.clone(),
                node: op,
                kind,
                permission: operation_permission(tree, op),
                transitions: if command {
                    strings(tree, op, A_TRANSITIONS)
                } else {
                    Vec::new()
                },
                errors: if command {
                    strings(tree, op, A_ERRORS)
                } else {
                    Vec::new()
                },
                target,
            });
    }

    by_package
        .into_iter()
        .map(|(package, (entities, operations))| {
            let mut permissions: BTreeSet<String> = BTreeSet::new();
            for e in &entities {
                permissions.extend(e.commands.iter().filter_map(|c| c.permission.clone()));
            }
            permissions.extend(operations.iter().filter_map(|o| o.permission.clone()));
            let errors: BTreeSet<String> = operations
                .iter()
                .flat_map(|o| o.errors.iter().cloned())
                .collect();
            RulesNamesPackage {
                package,
                entities,
                operations,
                permissions: permissions.into_iter().collect(),
                errors: errors.into_iter().collect(),
            }
        })
        .collect()
}
