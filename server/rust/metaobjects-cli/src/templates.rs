//! The template drift gate: `cargo meta verify --templates`.
//!
//! Every `template.*` node's body is checked against the payload value object it renders
//! over ([`metaobjects_render::verify`]), and a prompt's reply (`@responseRef`) is checked
//! against the tags the prompt asks the model to write. Follows the TypeScript gate
//! (`runTemplateVerify` in the CLI's `verify.ts`, and `response-verify.ts`); the reply rules
//! are pinned by `fixtures/response-verify-conformance/`.
//!
//! ADR-0039 holds throughout: every attribute and child is read through the resolving
//! accessors, so a template that inherits `@payloadRef`, `@textRef`, `@requiredTags` or
//! `@responseRef` through `extends` is checked with the inherited values.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use metaobjects::naming::strip_package;
use metaobjects::node::{NodeId, Tree};
use metaobjects::parser::TYPE_FIELD;
use metaobjects::validate::prompt::{
    ATTR_HTML_BODY_REF, ATTR_KIND, ATTR_OBJECT_REF, ATTR_PAYLOAD_REF, ATTR_REQUIRED_SLOTS,
    ATTR_RESPONSE_REF, ATTR_SUBJECT_REF, ATTR_TEXT_REF, FIELD_SUBTYPE_OBJECT as SUBTYPE_OBJECT,
    KIND_EMAIL, SUBTYPE_OUTPUT, SUBTYPE_PROMPT, TYPE_TEMPLATE,
};
use metaobjects::validate::rules::{str_attr, string_list};
use metaobjects::validate::util::ObjectIndex;
use metaobjects_codegen::project::LoadedProject;
use metaobjects_render::verify::{
    ERR_PARTIAL_UNRESOLVED, ERR_REQUIRED_SLOT_UNUSED, ERR_RESPONSE_TAG_UNDECLARED,
    ERR_RESPONSE_UNRESOLVED, ERR_TEMPLATE_ENGINE_UNSUPPORTED, PayloadField, VerifyOptions, verify,
};
use metaobjects_render::{Provider, tags};

/// The directory template bodies live in, under the project root, unless `--prompts` says so.
pub const DEFAULT_PROMPTS_DIR: &str = "prompts";

const KIND_DEFAULT: &str = "document";
const FORMAT_XML: &str = "xml";
const ATTR_TEXT_BODY_REF: &str = "textBodyRef";
const ATTR_REQUIRED_TAGS: &str = "requiredTags";
const ATTR_RESPONSE_FORMAT: &str = "responseFormat";

/// How a finding counts: an error fails the gate, a warning is printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// One finding about a prompt's reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseFinding {
    pub code: &'static str,
    /// The `@responseRef` value, or the offending tag.
    pub path: String,
    pub severity: Severity,
}

/// The payload field tree of a value object, walked as the payload generator walks it:
/// scalars are leaves, a `field.object` with an `@objectRef` recurses into the object the
/// loader bound. A reference cycle stops; an unresolved `vo` gives an empty tree.
#[must_use]
pub fn derive_payload_field_tree(
    tree: &Tree,
    index: &ObjectIndex,
    vo: Option<NodeId>,
) -> Vec<PayloadField> {
    fn walk(
        tree: &Tree,
        index: &ObjectIndex,
        vo: NodeId,
        seen: &mut Vec<NodeId>,
    ) -> Vec<PayloadField> {
        if seen.contains(&vo) {
            return Vec::new();
        }
        seen.push(vo);
        let fields = tree
            .children(vo)
            .iter()
            .map(|&f| (f, tree.node(f)))
            .filter(|(_, n)| n.type_name == TYPE_FIELD)
            .map(|(f, n)| {
                let nested = (n.sub_type == SUBTYPE_OBJECT
                    && str_attr(tree, f, ATTR_OBJECT_REF).is_some())
                .then(|| {
                    index
                        .ref_target(tree, f, ATTR_OBJECT_REF)
                        .map(|t| walk(tree, index, t, seen))
                        .unwrap_or_default()
                });
                PayloadField {
                    name: n.name.clone(),
                    fields: nested,
                    // Effective array-ness: `isArray` may be inherited through `extends`.
                    is_array: tree.resolved_is_array(f),
                }
            })
            .collect();
        seen.pop();
        fields
    }
    vo.map(|v| walk(tree, index, v, &mut Vec::new()))
        .unwrap_or_default()
}

fn field_names(fields: &[PayloadField], out: &mut HashSet<String>) {
    for f in fields {
        out.insert(f.name.clone());
        if let Some(nested) = &f.fields {
            field_names(nested, out);
        }
    }
}

/// The reply findings for one template. Empty for anything that is not a `template.prompt`
/// carrying `@responseRef`: a prompt that does not elicit a typed reply has nothing here.
#[must_use]
pub fn response_findings(tree: &Tree, index: &ObjectIndex, tmpl: NodeId) -> Vec<ResponseFinding> {
    let node = tree.node(tmpl);
    if node.type_name != TYPE_TEMPLATE || node.sub_type != SUBTYPE_PROMPT {
        return Vec::new();
    }
    // ADR-0039: effective attrs, a prompt may inherit @responseRef, @responseFormat and @requiredTags.
    let Some(response_ref) = str_attr(tree, tmpl, ATTR_RESPONSE_REF) else {
        return Vec::new();
    };
    let reply = index.ref_target(tree, tmpl, ATTR_RESPONSE_REF);
    let fields = derive_payload_field_tree(tree, index, reply);
    let Some(reply) = reply.filter(|_| !fields.is_empty()) else {
        return vec![ResponseFinding {
            code: ERR_RESPONSE_UNRESOLVED,
            path: response_ref.to_string(),
            severity: Severity::Error,
        }];
    };
    let is_xml = str_attr(tree, tmpl, ATTR_RESPONSE_FORMAT)
        .is_some_and(|f| f.eq_ignore_ascii_case(FORMAT_XML));
    if !is_xml {
        return Vec::new();
    }
    let mut known = HashSet::from([strip_package(&tree.node(reply).name).to_string()]);
    field_names(&fields, &mut known);
    string_list(tree, tmpl, ATTR_REQUIRED_TAGS)
        .into_iter()
        .filter(|t| !known.contains(*t))
        .map(|t| ResponseFinding {
            code: ERR_RESPONSE_TAG_UNDECLARED,
            path: t.to_string(),
            severity: Severity::Warning,
        })
        .collect()
}

/// Mustache first, then Jinja, then plain text: when both a `.mustache` and a `.jinja` body
/// exist, the Mustache one wins.
const EXTENSIONS: [&str; 6] = [".mustache", ".jinja", ".j2", ".jinja2", ".txt", ""];
const JINJA_EXTENSIONS: [&str; 3] = [".jinja", ".j2", ".jinja2"];

/// Maps a logical reference (`group/source`) onto a file under a base directory, trying the
/// conventional extensions.
pub struct FileProvider {
    base: PathBuf,
}

impl FileProvider {
    #[must_use]
    pub fn new(base: impl Into<PathBuf>) -> Self {
        Self { base: base.into() }
    }

    /// The file `reference` resolves to, if any is a file.
    #[must_use]
    pub fn path_of(&self, reference: &str) -> Option<PathBuf> {
        EXTENSIONS.iter().find_map(|ext| {
            let mut name = self.base.join(reference).into_os_string();
            name.push(ext);
            let path = PathBuf::from(name);
            path.is_file().then_some(path)
        })
    }
}

impl Provider for FileProvider {
    fn resolve(&self, reference: &str) -> Option<String> {
        self.path_of(reference)
            .and_then(|p| std::fs::read_to_string(p).ok())
    }

    fn is_jinja(&self, reference: &str) -> Option<bool> {
        self.path_of(reference).map(|p| is_jinja_path(&p))
    }
}

fn is_jinja_path(path: &Path) -> bool {
    let name = path.to_string_lossy().to_lowercase();
    JINJA_EXTENSIONS.iter().any(|e| name.ends_with(e))
}

/// The 1-based line of the first tag naming `path` (or its head segment) in a body, over
/// tags scanned once per body.
struct TagLines<'t> {
    text: &'t str,
    found: Vec<tags::Tag>,
}

impl<'t> TagLines<'t> {
    fn new(text: &'t str) -> Self {
        Self {
            text,
            found: tags::scan(text).unwrap_or_default(),
        }
    }

    fn line_of(&self, path: &str) -> Option<usize> {
        use tags::TagKind::{Amp, Inverted, Name, Section, Triple};
        let head = path.split('.').next().unwrap_or(path);
        let names: Vec<&str> = if head == path {
            vec![path]
        } else {
            vec![path, head]
        };
        names.iter().find_map(|name| {
            self.found
                .iter()
                .find(|t| {
                    matches!(t.kind, Name | Triple | Amp | Section | Inverted) && t.value == *name
                })
                .map(|t| self.text[..t.start].matches('\n').count() + 1)
        })
    }
}

/// The bodies a template renders, as `(label, ref)`, and whether the prompt-only
/// `@requiredSlots` / `@requiredTags` rules apply. `None` for a subtype this gate does not
/// know; an empty list for a template with no body reference (a loader concern, not this gate's).
fn body_refs(tree: &Tree, tmpl: NodeId) -> Option<(Vec<(&'static str, String)>, bool)> {
    let text = |name| str_attr(tree, tmpl, name).map(str::to_string);
    match tree.node(tmpl).sub_type.as_str() {
        SUBTYPE_PROMPT => Some((
            text(ATTR_TEXT_REF)
                .map(|r| ("prompt", r))
                .into_iter()
                .collect(),
            true,
        )),
        SUBTYPE_OUTPUT => {
            let kind = str_attr(tree, tmpl, ATTR_KIND)
                .unwrap_or(KIND_DEFAULT)
                .to_lowercase();
            let refs = if kind == KIND_EMAIL {
                [
                    ("email/subject", ATTR_SUBJECT_REF),
                    ("email/html", ATTR_HTML_BODY_REF),
                    ("email/text", ATTR_TEXT_BODY_REF),
                ]
                .into_iter()
                .filter_map(|(label, attr)| text(attr).map(|r| (label, r)))
                .collect()
            } else {
                text(ATTR_TEXT_REF)
                    .map(|r| ("document", r))
                    .into_iter()
                    .collect()
            };
            Some((refs, false))
        }
        _ => None,
    }
}

fn owned(items: Vec<&str>) -> Vec<String> {
    items.into_iter().map(str::to_string).collect()
}

/// What a run of the gate counted.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub errors: usize,
    pub warnings: usize,
    /// Templates the check engaged with: one whose body verified, or one that errored.
    pub checked: usize,
}

struct Gate<'a> {
    tree: &'a Tree,
    index: &'a ObjectIndex,
    provider: &'a FileProvider,
    prompts_dir: &'a Path,
    project_root: &'a Path,
    err: &'a mut dyn Write,
    tally: Tally,
}

impl Gate<'_> {
    fn error(&mut self, line: &str) {
        self.tally.errors += 1;
        let _ = writeln!(self.err, "error: {line}");
    }

    fn warn(&mut self, line: &str) {
        self.tally.warnings += 1;
        let _ = writeln!(self.err, "warning: {line}");
    }

    fn template(&mut self, tmpl: NodeId) {
        let name = self.tree.node(tmpl).name.clone();
        let mut reply_error = false;
        for f in response_findings(self.tree, self.index, tmpl) {
            let line = format!("[{name}] (reply) {}: {}", f.code, f.path);
            match f.severity {
                Severity::Error => {
                    self.error(&line);
                    reply_error = true;
                }
                Severity::Warning => self.warn(&line),
            }
        }
        if self.body(tmpl, &name) || reply_error {
            self.tally.checked += 1;
        }
    }

    /// One template's body against its payload; true when the check engaged with it.
    fn body(&mut self, tmpl: NodeId, name: &str) -> bool {
        let tree = self.tree;
        // ADR-0039: effective attrs, @payloadRef may be inherited via an abstract template.
        // A typeless or absent @payloadRef is a loader-schema concern, not this gate's.
        let Some(payload_ref) = str_attr(tree, tmpl, ATTR_PAYLOAD_REF) else {
            return false;
        };
        let sub_type = tree.node(tmpl).sub_type.clone();
        let fields = derive_payload_field_tree(
            tree,
            self.index,
            self.index.ref_target(tree, tmpl, ATTR_PAYLOAD_REF),
        );
        if fields.is_empty() {
            self.error(&format!(
                "[{name}] ({sub_type}) {ERR_PARTIAL_UNRESOLVED}: @payloadRef \"{payload_ref}\" did not resolve to a loaded object.value"
            ));
            return true;
        }
        let Some((refs, prompt_rules)) = body_refs(tree, tmpl) else {
            return false;
        };
        if refs.is_empty() {
            return false;
        }
        let (required_slots, required_tags) = if prompt_rules {
            (
                owned(string_list(tree, tmpl, ATTR_REQUIRED_SLOTS)),
                owned(string_list(tree, tmpl, ATTR_REQUIRED_TAGS)),
            )
        } else {
            (Vec::new(), Vec::new())
        };
        let opts = VerifyOptions {
            provider: Some(self.provider),
            required_slots,
            required_tags,
        };
        let (mut any_checked, mut any_error) = (false, false);
        for (label, reference) in refs {
            let file = self.provider.path_of(&reference);
            let Some(text) = file.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) else {
                let dir = self.prompts_dir.display();
                self.error(&format!(
                    "[{name}] ({label}) {ERR_PARTIAL_UNRESOLVED}: ref \"{reference}\" did not resolve under {dir} — create {dir}/{reference}.mustache (or .txt), or point --prompts at the directory that holds it"
                ));
                any_error = true;
                continue;
            };
            if file.as_deref().is_some_and(is_jinja_path) {
                self.error(&format!(
                    "[{name}] ({label}) {ERR_TEMPLATE_ENGINE_UNSUPPORTED}: {reference} is a Jinja template; the Rust port checks Mustache only"
                ));
                any_error = true;
                continue;
            }
            any_checked = true;
            let lines = TagLines::new(&text);
            for finding in verify(&text, &fields, &opts) {
                let line = lines.line_of(&finding.path).map(|l| format!(":{l}"));
                let at = file.as_deref().map_or_else(String::new, |f| {
                    let rel = f.strip_prefix(self.project_root).unwrap_or(f);
                    format!(" ({}{})", rel.display(), line.unwrap_or_default())
                });
                let line = format!("[{name}] ({label}) {}: {}{at}", finding.code, finding.path);
                if finding.code == ERR_REQUIRED_SLOT_UNUSED {
                    self.warn(&line);
                } else {
                    self.error(&line);
                    any_error = true;
                }
            }
        }
        any_checked || any_error
    }
}

/// Run the gate over a loaded project, printing findings to `err` and the verdict line to
/// `out` or `err`. Returns the exit status: 0 clean, 1 on any error. A project with no
/// `template.*` node says so only when `announce_empty` (the gate was asked for by name);
/// inside a bare `verify` it stays silent, as a model with no operations is on the rules gate.
pub fn run(
    project: &LoadedProject,
    prompts_dir: &Path,
    tool: &str,
    announce_empty: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let result = &project.result;
    let tree = &result.tree;
    let index = ObjectIndex::build(tree, result.root);
    // ADR-0039: effective children, resolved rather than relying on the root being unextended.
    let templates: Vec<NodeId> = tree
        .children(result.root)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_TEMPLATE)
        .collect();
    if templates.is_empty() {
        if announce_empty {
            let _ = writeln!(
                out,
                "{tool} verify — no template.* nodes found; the template gate had nothing to check."
            );
        }
        return 0;
    }
    let provider = FileProvider::new(prompts_dir);
    let mut gate = Gate {
        tree,
        index: &index,
        provider: &provider,
        prompts_dir,
        project_root: &project.collection.config_dir,
        err,
        tally: Tally::default(),
    };
    for tmpl in templates {
        gate.template(tmpl);
    }
    let Tally {
        errors,
        warnings,
        checked,
    } = gate.tally;
    if errors > 0 {
        let _ = writeln!(
            err,
            "{tool} verify — {errors} drift error(s) across {checked} template(s)."
        );
        return 1;
    }
    let note = if warnings > 0 {
        format!(" ({warnings} warning(s))")
    } else {
        String::new()
    };
    let _ = writeln!(out, "{tool} verify — {checked} template(s) clean{note}.");
    0
}
