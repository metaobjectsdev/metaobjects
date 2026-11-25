//! `cargo meta verify`: the business-rules gate (ADR-0066).
//!
//! The loader refuses a model whose operations or lifecycles are malformed. This gate reports
//! what loads clean but is almost certainly not what the author meant: a state nothing can
//! reach, a lifecycle that cannot move, a transition nothing can make, and (by setting) a
//! permission name the model derived instead of declaring.
//!
//! A port of the TypeScript reference (`cli/src/lib/rules-check.ts`), through the Python port
//! that mirrors it: the codes, severities, paths and message text are the contract, held by
//! `fixtures/rules-check-conformance/`. A model that declares no operation and no transition
//! gets no diagnostics and no summary: the gate is opt-in by declaration, so a project that
//! declares none sees no change.
//!
//! The four `rules.*` settings (`rules.permissions.names`, `rules.lifecycle.commands`,
//! `rules.lifecycle.create`, `verify.lifecycle.unreachable`) are read from the project's
//! config. `rules.lifecycle.create` changes nothing this gate reports.
//!
//! Checks, in the order they are reported:
//!
//! * `WARN_LIFECYCLE_UNREACHABLE_STATE`: states no transition reaches from the initial state
//!   (severity: `verify.lifecycle.unreachable`)
//! * `WARN_LIFECYCLE_INITIAL_TERMINAL`: the initial state is one no transition leaves
//! * `WARN_TRANSITION_UNREACHABLE`: a transition whose every `@from` state is unreachable
//!   (severity: `verify.lifecycle.unreachable`)
//! * `WARN_TRANSITION_PERMISSION_SHADOWED`: a transition declaring `@permission` or
//!   `@public: true` that derives no command of its own, so the attribute is never read
//! * `WARN_PERMISSION_DERIVED_NAME`: a transition that derives its own command, or an
//!   operation, with no `@permission` and not `@public` (severity: `rules.permissions.names`)
//!
//! Lifecycles are checked once per declaring field, so a lifecycle on an abstract base is
//! reported once, not once per inheritor. A derived command exists per concrete entity, so the
//! permission check runs per concrete entity and names it. Every read is resolving (ADR-0039).

use serde_json::Value;

use crate::config::{
    RulesLifecycleCommands, RulesPermissionNames, RulesSettings, VerifyLifecycleUnreachable,
};
use crate::node::{NodeId, PACKAGE_SEP, Tree};
use crate::parser::{TYPE_FIELD, TYPE_OBJECT};
use crate::validate::Env;
use crate::validate::rules::{
    derive_operation_target, entity_lineage, entity_transitions, is_a, is_true,
    lifecycle_transitions_of, resolve_object_on, str_attr, string_list,
};
use crate::validate::util::ObjectIndex;

pub const WARN_LIFECYCLE_UNREACHABLE_STATE: &str = "WARN_LIFECYCLE_UNREACHABLE_STATE";
pub const WARN_LIFECYCLE_INITIAL_TERMINAL: &str = "WARN_LIFECYCLE_INITIAL_TERMINAL";
pub const WARN_TRANSITION_UNREACHABLE: &str = "WARN_TRANSITION_UNREACHABLE";
pub const WARN_PERMISSION_DERIVED_NAME: &str = "WARN_PERMISSION_DERIVED_NAME";
pub const WARN_TRANSITION_PERMISSION_SHADOWED: &str = "WARN_TRANSITION_PERMISSION_SHADOWED";

const T_API: &str = "api";
const T_OPERATION: &str = "operation";
const T_SOURCE: &str = "source";
const SUB_ENTITY: &str = "entity";
const SUB_ENUM: &str = "enum";
const SUB_COMMAND: &str = "command";
const A_DEFAULT: &str = "default";
const A_VALUES: &str = "values";
const A_FROM: &str = "from";
const A_TO: &str = "to";
const A_PERMISSION: &str = "permission";
const A_PUBLIC: &str = "public";
const A_TRANSITIONS: &str = "transitions";
const A_OBJECT_REF: &str = "objectRef";

/// How serious a finding is. The code keeps its `WARN_` prefix at every severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warn,
    Error,
}

impl Severity {
    /// The word the shared corpus writes.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }
}

/// One finding: what is wrong, at which node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: &'static str,
    /// The package-qualified address of the node, `acme::shop::Order.status.submit`.
    pub path: String,
    pub message: String,
}

/// What the model declares, for the line `verify` prints on every run that has any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesSummary {
    /// Declared operations, across every `api.operational`.
    pub operations: usize,
    /// Lifecycles: enum fields that declare at least one transition.
    pub lifecycles: usize,
    /// Declared transitions, across every lifecycle.
    pub transitions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesCheckResult {
    pub diagnostics: Vec<Diagnostic>,
    /// `None` when the model declares no operation and no transition.
    pub summary: Option<RulesSummary>,
}

impl RulesCheckResult {
    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
    }
}

/// One lifecycle: an enum field with at least one transition.
pub(crate) struct Lifecycle<'a> {
    pub(crate) field: NodeId,
    /// The enum's `@values`, in declaration order.
    pub(crate) states: Vec<&'a str>,
    /// The enum's `@default`; `None` only on a model the loader refused.
    pub(crate) initial: Option<&'a str>,
    pub(crate) transitions: Vec<NodeId>,
}

fn quote_list<S: AsRef<str>>(xs: &[S]) -> String {
    xs.iter()
        .map(|x| format!("\"{}\"", x.as_ref()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A node's package-qualified address: `acme::shop::Order.status.submit`.
pub fn rules_address(tree: &Tree, node: NodeId) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = node;
    while let Some(parent) = tree.node(cur).parent {
        let name = tree.node(cur).name.as_str();
        if !name.is_empty() {
            parts.push(name);
        }
        cur = parent;
    }
    parts.reverse();
    let pkg = tree.effective_package(tree.top_level_of(node));
    if pkg.is_empty() {
        parts.join(".")
    } else {
        format!("{pkg}{PACKAGE_SEP}{}", parts.join("."))
    }
}

/// The permission name a node gets when it declares none, `<package>.<path>`: the path is
/// `<operation>` for a declared operation and `<Entity>.<transition>` for a transition's
/// derived command, so two entities' transitions of one name ask about different permissions.
pub(crate) fn derived_permission_name(tree: &Tree, owner: NodeId, path: &str) -> String {
    let pkg = tree.effective_package(tree.top_level_of(owner));
    if pkg.is_empty() {
        path.to_string()
    } else {
        format!("{pkg}.{path}")
    }
}

fn needs_permission_name(tree: &Tree, node: NodeId) -> bool {
    tree.attr(node, A_PERMISSION).is_none() && !is_true(tree, node, A_PUBLIC)
}

pub(crate) fn entities(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    tree.children(root)
        .iter()
        .copied()
        .filter(|&c| is_a(tree, c, TYPE_OBJECT, SUB_ENTITY))
        .collect()
}

pub(crate) fn operations(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    tree.children(root)
        .iter()
        .copied()
        .filter(|&a| tree.node(a).type_name == T_API)
        .flat_map(|api| {
            tree.children(api)
                .iter()
                .copied()
                .filter(|&o| tree.node(o).type_name == T_OPERATION)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The lifecycles of an entity, in effective field order.
pub(crate) fn lifecycles_of<'a>(tree: &'a Tree, entity: NodeId) -> Vec<Lifecycle<'a>> {
    if !is_a(tree, entity, TYPE_OBJECT, SUB_ENTITY) {
        return Vec::new();
    }
    let lineage = entity_lineage(tree, entity);
    let mut out = Vec::new();
    for &field in tree.children(entity).iter() {
        if !is_a(tree, field, TYPE_FIELD, SUB_ENUM) {
            continue;
        }
        let transitions = lifecycle_transitions_of(tree, &lineage, field);
        if transitions.is_empty() {
            continue;
        }
        out.push(Lifecycle {
            field,
            states: string_list(tree, field, A_VALUES),
            initial: str_attr(tree, field, A_DEFAULT),
            transitions,
        });
    }
    out
}

/// Every lifecycle of the model, once per declaring field, in model order.
fn declared_lifecycles<'a>(tree: &'a Tree, root: NodeId) -> Vec<Lifecycle<'a>> {
    let mut seen: Vec<NodeId> = Vec::new();
    let mut out = Vec::new();
    for entity in entities(tree, root) {
        for l in lifecycles_of(tree, entity) {
            if seen.contains(&l.field) {
                continue;
            }
            seen.push(l.field);
            out.push(l);
        }
    }
    out
}

/// Whether an entity's lifecycles are live: it declares or inherits a source. A lifecycle on
/// an entity with no source loads and is inert: it derives no command.
pub(crate) fn lifecycle_is_live(tree: &Tree, entity: NodeId) -> bool {
    tree.children(entity)
        .iter()
        .any(|&c| tree.node(c).type_name == T_SOURCE)
}

pub(crate) fn transition_from(tree: &Tree, t: NodeId) -> Vec<&str> {
    string_list(tree, t, A_FROM)
}

fn reachable_states<'a>(tree: &'a Tree, l: &Lifecycle<'a>) -> Vec<&'a str> {
    let Some(initial) = l.initial else {
        return Vec::new();
    };
    let mut seen = vec![initial];
    let mut queue = vec![initial];
    while !queue.is_empty() {
        let s = queue.remove(0);
        for &t in &l.transitions {
            let Some(to) = str_attr(tree, t, A_TO) else {
                continue;
            };
            if transition_from(tree, t).contains(&s) && !seen.contains(&to) {
                seen.push(to);
                queue.push(to);
            }
        }
    }
    seen
}

/// The members no transition leaves (a self-transition counts as leaving).
pub(crate) fn terminal_states<'a>(tree: &Tree, l: &Lifecycle<'a>) -> Vec<&'a str> {
    let leaving: Vec<&str> = l
        .transitions
        .iter()
        .flat_map(|&t| transition_from(tree, t))
        .collect();
    l.states
        .iter()
        .copied()
        .filter(|s| !leaving.contains(s))
        .collect()
}

fn check_lifecycle(
    tree: &Tree,
    l: &Lifecycle<'_>,
    settings: &RulesSettings,
    out: &mut Vec<Diagnostic>,
) {
    let where_ = rules_address(tree, l.field);
    let Some(initial) = l.initial else {
        return; // the loader refused this model (ERR_LIFECYCLE_NO_INITIAL)
    };
    let field_name = tree.node(l.field).name.as_str();
    let reachable = reachable_states(tree, l);
    let unreachable_severity = match settings.lifecycle_unreachable {
        VerifyLifecycleUnreachable::Off => None,
        VerifyLifecycleUnreachable::Warn => Some(Severity::Warn),
        VerifyLifecycleUnreachable::Error => Some(Severity::Error),
    };

    if let Some(severity) = unreachable_severity {
        let unreachable: Vec<&str> = l
            .states
            .iter()
            .copied()
            .filter(|s| !reachable.contains(s))
            .collect();
        if !unreachable.is_empty() {
            let one = unreachable.len() == 1;
            out.push(Diagnostic {
                severity,
                code: WARN_LIFECYCLE_UNREACHABLE_STATE,
                path: where_.clone(),
                message: format!(
                    "{} {} of \"{field_name}\" cannot be reached from the initial state \"{initial}\" by any transition. \
                     Add the transition that leads there, or set verify.lifecycle.unreachable if only seeded data uses {}.",
                    if one { "state" } else { "states" },
                    quote_list(&unreachable),
                    if one { "it" } else { "them" },
                ),
            });
        }
    }

    if terminal_states(tree, l).contains(&initial) {
        out.push(Diagnostic {
            severity: Severity::Warn,
            code: WARN_LIFECYCLE_INITIAL_TERMINAL,
            path: where_,
            message: format!(
                "the initial state \"{initial}\" of \"{field_name}\" is terminal: no transition leaves it, \
                 so no row of this lifecycle can ever move."
            ),
        });
    }

    if let Some(severity) = unreachable_severity {
        for &t in &l.transitions {
            let from = transition_from(tree, t);
            if from.is_empty() || from.iter().any(|s| reachable.contains(s)) {
                continue;
            }
            out.push(Diagnostic {
                severity,
                code: WARN_TRANSITION_UNREACHABLE,
                path: rules_address(tree, t),
                message: format!(
                    "transition \"{}\" starts only from {}, which no transition reaches from \
                     the initial state \"{initial}\", so it can never be made.",
                    tree.node(t).name,
                    quote_list(&from),
                ),
            });
        }
    }
}

/// One command's claim on a transition node, made for its target entity.
pub(crate) struct Claim {
    target: NodeId,
    op: NodeId,
}

/// The operation's target: the declared `@objectRef` when it names an entity, else the
/// derived one.
pub(crate) fn operation_target(env: &Env<'_>, op: NodeId) -> Option<NodeId> {
    if let Some(declared) = str_attr(env.tree, op, A_OBJECT_REF) {
        return resolve_object_on(env, op, declared)
            .filter(|&n| env.tree.node(n).sub_type == SUB_ENTITY);
    }
    derive_operation_target(env, op).map(|(entity, _)| entity)
}

/// Each transition node the declared commands claim, with the claims on it in model order.
pub(crate) fn claimed_transitions(env: &Env<'_>, root: NodeId) -> Vec<(NodeId, Vec<Claim>)> {
    let tree = env.tree;
    let mut claimed: Vec<(NodeId, Vec<Claim>)> = Vec::new();
    for op in operations(tree, root) {
        if tree.node(op).sub_type != SUB_COMMAND {
            continue;
        }
        let Some(target) = operation_target(env, op) else {
            continue;
        };
        let names = string_list(tree, op, A_TRANSITIONS);
        for t in entity_transitions(tree, target) {
            if !names.contains(&tree.node(t).name.as_str()) {
                continue;
            }
            let claim = Claim { target, op };
            match claimed.iter_mut().find(|(n, _)| *n == t) {
                Some((_, claims)) => claims.push(claim),
                None => claimed.push((t, vec![claim])),
            }
        }
    }
    claimed
}

/// The claims that cover transition `t` on `entity`: those made for the entity or an entity
/// it extends.
fn claims_on<'c>(
    tree: &Tree,
    claimed: &'c [(NodeId, Vec<Claim>)],
    entity: NodeId,
    t: NodeId,
) -> Vec<&'c Claim> {
    let lineage = entity_lineage(tree, entity);
    claimed
        .iter()
        .find(|(n, _)| *n == t)
        .map(|(_, claims)| {
            claims
                .iter()
                .filter(|c| lineage.contains(&c.target))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `t`, carried by `entity`, derives a command of its own under the setting.
pub(crate) fn derives_command(
    tree: &Tree,
    claimed: &[(NodeId, Vec<Claim>)],
    settings: &RulesSettings,
    entity: NodeId,
    t: NodeId,
) -> bool {
    match settings.lifecycle_commands {
        RulesLifecycleCommands::NoneDerived => false,
        RulesLifecycleCommands::All => true,
        RulesLifecycleCommands::Unclaimed => claims_on(tree, claimed, entity, t).is_empty(),
    }
}

/// The entities a transition can derive a command on: concrete, with a source.
pub(crate) fn command_entities(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    entities(tree, root)
        .into_iter()
        .filter(|&e| !tree.node(e).is_abstract && lifecycle_is_live(tree, e))
        .collect()
}

/// A transition's `@permission` or `@public` is read only by the command derived from it. One
/// that derives no command for any concrete entity carrying it declares an attribute nothing
/// reads.
fn check_shadowed_permissions(
    env: &Env<'_>,
    root: NodeId,
    settings: &RulesSettings,
    out: &mut Vec<Diagnostic>,
) {
    let tree = env.tree;
    if settings.lifecycle_commands == RulesLifecycleCommands::All {
        return;
    }
    let claimed = claimed_transitions(env, root);
    let mut carriers: Vec<(NodeId, Vec<NodeId>)> = Vec::new();
    for entity in command_entities(tree, root) {
        for t in entity_transitions(tree, entity) {
            match carriers.iter_mut().find(|(n, _)| *n == t) {
                Some((_, list)) => list.push(entity),
                None => carriers.push((t, vec![entity])),
            }
        }
    }
    for (t, with_t) in &carriers {
        let t = *t;
        let permission = tree.attr(t, A_PERMISSION);
        let is_public = is_true(tree, t, A_PUBLIC);
        if permission.is_none() && !is_public {
            continue;
        }
        if with_t
            .iter()
            .any(|&e| derives_command(tree, &claimed, settings, e, t))
        {
            continue;
        }
        let declared = match permission {
            Some(Value::String(p)) => format!("@permission \"{p}\""),
            Some(other) => format!("@permission \"{other}\""),
            None => "@public: true".to_string(),
        };
        let mut claimers: Vec<String> = Vec::new();
        for &e in with_t {
            for c in claims_on(tree, &claimed, e, t) {
                let api = tree
                    .node(c.op)
                    .parent
                    .map(|p| tree.node(p).name.as_str())
                    .unwrap_or("");
                let label = format!("{api}.{}", tree.node(c.op).name);
                if !claimers.contains(&label) {
                    claimers.push(label);
                }
            }
        }
        let why = if settings.lifecycle_commands == RulesLifecycleCommands::NoneDerived {
            "rules.lifecycle.commands is \"none\": no command is derived from it".to_string()
        } else {
            let one = claimers.len() == 1;
            format!(
                "it derives no command of its own: it is made only by {}, which {} the policy about {} own permission",
                quote_list(&claimers),
                if one { "asks" } else { "ask" },
                if one { "its" } else { "their" },
            )
        };
        out.push(Diagnostic {
            severity: Severity::Warn,
            code: WARN_TRANSITION_PERMISSION_SHADOWED,
            path: rules_address(tree, t),
            message: format!(
                "transition \"{}\" declares {declared}, but {why}, so the attribute is never read. \
                 Remove it from the transition, or declare it on the command that makes the transition.",
                tree.node(t).name,
            ),
        });
    }
}

fn check_permission_names(
    env: &Env<'_>,
    root: NodeId,
    settings: &RulesSettings,
    out: &mut Vec<Diagnostic>,
) {
    let tree = env.tree;
    let severity = match settings.permission_names {
        RulesPermissionNames::Derive => return,
        RulesPermissionNames::Advise => Severity::Warn,
        RulesPermissionNames::Require => Severity::Error,
    };
    let advice = |kind: &str| {
        format!("which changes if the {kind} is renamed. Declare @permission, or @public: true.")
    };

    if settings.lifecycle_commands != RulesLifecycleCommands::NoneDerived {
        let claimed = claimed_transitions(env, root);
        for entity in command_entities(tree, root) {
            for t in entity_transitions(tree, entity) {
                if !derives_command(tree, &claimed, settings, entity, t)
                    || !needs_permission_name(tree, t)
                {
                    continue;
                }
                let field_name = tree
                    .node(t)
                    .parent
                    .map(|f| tree.node(f).name.as_str())
                    .unwrap_or("");
                let entity_name = tree.node(entity).name.as_str();
                let t_name = tree.node(t).name.as_str();
                out.push(Diagnostic {
                    severity,
                    code: WARN_PERMISSION_DERIVED_NAME,
                    path: format!("{}.{field_name}.{t_name}", rules_address(tree, entity)),
                    message: format!(
                        "the command derived from transition \"{t_name}\" of \"{entity_name}\" has no @permission, \
                         so it asks the policy about the derived name \"{}\", {}",
                        derived_permission_name(tree, entity, &format!("{entity_name}.{t_name}")),
                        advice("transition"),
                    ),
                });
            }
        }
    }

    for op in operations(tree, root) {
        if !needs_permission_name(tree, op) {
            continue;
        }
        let n = tree.node(op);
        out.push(Diagnostic {
            severity,
            code: WARN_PERMISSION_DERIVED_NAME,
            path: rules_address(tree, op),
            message: format!(
                "operation.{} \"{}\" has no @permission, so it asks the policy about the \
                 derived name \"{}\", {}",
                n.sub_type,
                n.name,
                derived_permission_name(tree, op, &n.name),
                advice("operation"),
            ),
        });
    }
}

/// The rules gate over a loaded model. `objects` is the loader's index of the root's objects
/// (`ObjectIndex::build(tree, root)`).
pub fn check_rules(
    tree: &Tree,
    root: NodeId,
    objects: &ObjectIndex,
    settings: &RulesSettings,
) -> RulesCheckResult {
    let env = Env { tree, objects };
    let lifecycles = declared_lifecycles(tree, root);
    let ops = operations(tree, root);
    if lifecycles.is_empty() && ops.is_empty() {
        return RulesCheckResult {
            diagnostics: Vec::new(),
            summary: None,
        };
    }
    let mut diagnostics = Vec::new();
    for l in &lifecycles {
        check_lifecycle(tree, l, settings, &mut diagnostics);
    }
    check_shadowed_permissions(&env, root, settings, &mut diagnostics);
    check_permission_names(&env, root, settings, &mut diagnostics);
    RulesCheckResult {
        diagnostics,
        summary: Some(RulesSummary {
            operations: ops.len(),
            lifecycles: lifecycles.len(),
            transitions: lifecycles.iter().map(|l| l.transitions.len()).sum(),
        }),
    }
}
