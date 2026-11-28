//! The project's generator list: which generators `cargo meta gen` and `verify` run.
//!
//! A project chooses its generators in `metaobjects.config.json` at the project root, the way
//! `metaobjects.config.ts`, `codegen/Generators.cs`, the pom and `metaobjects.config.yaml` do in
//! the other ports, so changing the list never needs an eject:
//!
//! ```json
//! { "generators": ["entity", "rules-names", "contract-types", "repository", "service", "client", "commands", "render-helper", "output-parser", "output-prompt"] }
//! ```
//!
//! An entry is a generator's name, or `{"name": "...", "options": {...}}` to construct it with
//! options: they reach the generator through [`crate::Generator::configure`], and a generator
//! refuses an option it does not take, so a misspelt one fails the run instead of being
//! ignored. The shipped generators take none yet. The list carries no layer or set settings,
//! because a layer is only a generator. A project with no such file runs every generator its host
//! offers but the opt-in ones (the `service-routes` transport, which brings a web framework into
//! the build, and `metamodel-docs`, which writes reference pages no project asked for), which is
//! what a project did before the file existed. A list may leave a generator
//! out; generated files of a generator that left the list are swept like those of any
//! generator that stops emitting them (an edited one is refused by name).
//!
//! The file is the tool's own, not the shared `.metaobjects/config.json`: that file's keys are
//! one contract across six ports, and a generator list is each port's own way of choosing.

use std::path::Path;

use crate::eject;
use crate::generator::Options;

/// The file that holds the list, from the project root.
pub const GENERATOR_LIST_FILE: &str = "metaobjects.config.json";

/// The one key the file takes.
const KEY: &str = "generators";
/// The keys an entry written as an object takes.
const ENTRY_NAME: &str = "name";
const ENTRY_OPTIONS: &str = "options";

/// One entry of the list: a generator, and the options the project constructs it with
/// (empty for an entry written as a bare name).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry {
    pub name: String,
    pub options: Options,
}

impl Entry {
    /// An entry with no options.
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            options: Options::new(),
        }
    }
}

/// The generator names of `entries`, in order.
pub fn names(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

/// The list the project wrote, in the order it wrote it, or `None` when the project has no
/// such file. Anything wrong with the file is an error naming the file and what to change.
pub fn read(project_root: &Path) -> Result<Option<Vec<Entry>>, String> {
    let path = project_root.join(GENERATOR_LIST_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("reading {GENERATOR_LIST_FILE}: {e}")),
    };
    parse(&text).map(Some)
}

/// The list in `text`, the contents of [`GENERATOR_LIST_FILE`].
pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("{GENERATOR_LIST_FILE} is not valid JSON: {e}"))?;
    let Some(object) = value.as_object() else {
        return Err(format!(
            "{GENERATOR_LIST_FILE} must be an object with a \"{KEY}\" list, as written by `cargo meta init`"
        ));
    };
    if let Some(unknown) = object.keys().find(|k| k.as_str() != KEY) {
        return Err(format!(
            "{GENERATOR_LIST_FILE} has an unknown key \"{unknown}\". The only key is \"{KEY}\": \
             the generators to run, each a name or {{\"{ENTRY_NAME}\": ..., \"{ENTRY_OPTIONS}\": {{...}}}}. A layer is just a generator"
        ));
    }
    let Some(list) = object.get(KEY).and_then(|v| v.as_array()) else {
        return Err(format!(
            "{GENERATOR_LIST_FILE} needs a \"{KEY}\" list of generator names, \
             for example {}",
            example()
        ));
    };
    let mut entries: Vec<Entry> = Vec::with_capacity(list.len());
    for item in list {
        let entry = entry(item)?;
        if entries.iter().any(|e| e.name == entry.name) {
            return Err(format!(
                "{GENERATOR_LIST_FILE}: \"{}\" is listed twice; a generator runs once",
                entry.name
            ));
        }
        entries.push(entry);
    }
    Ok(entries)
}

/// One entry: a name, or an object with a `name` and optional `options`.
fn entry(item: &serde_json::Value) -> Result<Entry, String> {
    let shape = || {
        format!(
            "{GENERATOR_LIST_FILE}: every entry of \"{KEY}\" is a generator name (a string) or \
             {{\"{ENTRY_NAME}\": \"...\", \"{ENTRY_OPTIONS}\": {{...}}}}, got {item}"
        )
    };
    if let Some(name) = item.as_str() {
        return Ok(Entry::named(name));
    }
    let Some(object) = item.as_object() else {
        return Err(shape());
    };
    let Some(name) = object.get(ENTRY_NAME).and_then(|v| v.as_str()) else {
        return Err(shape());
    };
    if let Some(unknown) = object
        .keys()
        .find(|k| k.as_str() != ENTRY_NAME && k.as_str() != ENTRY_OPTIONS)
    {
        return Err(format!(
            "{GENERATOR_LIST_FILE}: the entry for \"{name}\" has an unknown key \"{unknown}\"; \
             an entry takes \"{ENTRY_NAME}\" and \"{ENTRY_OPTIONS}\" (the generator's own options)"
        ));
    }
    let options = match object.get(ENTRY_OPTIONS) {
        None => Options::new(),
        Some(serde_json::Value::Object(o)) => o.clone(),
        Some(other) => {
            return Err(format!(
                "{GENERATOR_LIST_FILE}: the \"{ENTRY_OPTIONS}\" of \"{name}\" must be an object of \
                 option names to values, got {other}"
            ));
        }
    };
    Ok(Entry {
        name: name.to_string(),
        options,
    })
}

/// Check a list against the generators a host offers: each name is one of them, and a shipped
/// generator that builds on another has it in the list too.
pub fn check(names: &[String], available: &[&str]) -> Result<(), String> {
    if let Some(bad) = names.iter().find(|n| !available.contains(&n.as_str())) {
        return Err(format!(
            "{GENERATOR_LIST_FILE} lists the generator \"{bad}\", which is not available; \
             available: {}. (`cargo meta gen --list` shows them)",
            available.join(", ")
        ));
    }
    for name in names {
        let Some(shipped) = eject::reference(name) else {
            continue;
        };
        if let Some(missing) = shipped
            .needs
            .iter()
            .find(|n| !names.iter().any(|x| x == **n))
        {
            return Err(format!(
                "{GENERATOR_LIST_FILE} lists \"{name}\" without \"{missing}\", which it builds on; \
                 add \"{missing}\" to \"{KEY}\" or take \"{name}\" out"
            ));
        }
    }
    Ok(())
}

/// Every shipped generator's name, in the order a run applies them.
pub fn shipped_names() -> Vec<&'static str> {
    eject::REFERENCES.iter().map(|r| r.name).collect()
}

/// Whether a project with no list runs the generator `name`: every one but a shipped opt-in.
pub fn runs_unlisted(name: &str) -> bool {
    !eject::reference(name).is_some_and(|r| r.opt_in)
}

fn example() -> String {
    format!(
        "{{ \"{KEY}\": [{}] }}",
        shipped_names()
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// The text `cargo meta init` writes: every shipped generator but the opt-in ones, and those
/// too with `opt_in`, so a new project generates what it always has and removes one by deleting
/// a line.
pub fn scaffold(opt_in: bool) -> String {
    let items = eject::REFERENCES
        .iter()
        .filter(|r| opt_in || !r.opt_in)
        .map(|r| format!("    \"{}\"", r.name))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("{{\n  \"{KEY}\": [\n{items}\n  ]\n}}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn the_scaffold_parses_and_names_every_shipped_generator_in_run_order() {
        assert_eq!(
            names(&parse(&scaffold(false)).unwrap()),
            s(&[
                "entity",
                "rules-names",
                "contract-types",
                "repository",
                "service",
                "client",
                "commands",
                "render-helper",
                "output-parser",
                "output-prompt"
            ])
        );
        assert!(check(&names(&parse(&scaffold(false)).unwrap()), &shipped_names()).is_ok());
        let all = names(&parse(&scaffold(true)).unwrap());
        assert_eq!(all, s(&shipped_names()));
        assert!(check(&all, &shipped_names()).is_ok());
        assert!(
            !runs_unlisted("service-routes")
                && !runs_unlisted("metamodel-docs")
                && runs_unlisted("entity")
        );
    }

    #[test]
    fn a_file_that_is_not_a_list_of_names_is_refused_with_what_to_change() {
        for (text, wants) in [
            ("{", "not valid JSON"),
            ("[]", "must be an object"),
            ("{}", "needs a \"generators\" list"),
            (
                "{\"generators\": \"entity\"}",
                "needs a \"generators\" list",
            ),
            ("{\"generators\": [1]}", "generator name (a string)"),
            (
                "{\"generators\": [{\"options\": {}}]}",
                "generator name (a string)",
            ),
            (
                "{\"generators\": [{\"name\": \"entity\", \"packages\": []}]}",
                "the entry for \"entity\" has an unknown key \"packages\"",
            ),
            (
                "{\"generators\": [{\"name\": \"entity\", \"options\": []}]}",
                "must be an object of option names",
            ),
            (
                "{\"generators\": [\"entity\", {\"name\": \"entity\"}]}",
                "listed twice",
            ),
            ("{\"generators\": [\"entity\", \"entity\"]}", "listed twice"),
            (
                "{\"generators\": [], \"layers\": {}}",
                "unknown key \"layers\"",
            ),
        ] {
            let e = parse(text).unwrap_err();
            assert!(e.contains(wants), "{text}: {e}");
            assert!(e.contains(GENERATOR_LIST_FILE), "{e}");
        }
        assert_eq!(parse("{\"generators\": []}").unwrap(), Vec::<Entry>::new());
    }

    #[test]
    fn an_entry_is_a_name_or_a_name_with_its_options() {
        let entries =
            parse(r#"{"generators": ["entity", {"name": "client", "options": {"pageSize": 25}}, {"name": "commands"}]}"#)
                .unwrap();
        assert_eq!(names(&entries), s(&["entity", "client", "commands"]));
        assert!(entries[0].options.is_empty() && entries[2].options.is_empty());
        assert_eq!(
            entries[1].options.get("pageSize"),
            Some(&serde_json::json!(25))
        );
    }

    #[test]
    fn a_name_nothing_offers_and_a_missing_dependency_are_refused() {
        let available = shipped_names();
        let e = check(&s(&["entity", "nope"]), &available).unwrap_err();
        assert!(
            e.contains("\"nope\"")
                && e.contains("available: entity, rules-names, contract-types, repository, service, service-routes, client, commands, render-helper, output-parser, output-prompt, metamodel-docs"),
            "{e}"
        );
        let e = check(&s(&["client"]), &available).unwrap_err();
        assert!(e.contains("\"client\" without \"entity\""), "{e}");
        let e = check(&s(&["entity", "commands"]), &available).unwrap_err();
        assert!(e.contains("\"commands\" without \"client\""), "{e}");
        assert!(check(&s(&["entity", "client"]), &available).is_ok());
        assert!(check(&s(&["entity"]), &available).is_ok());
        // A project's own generator has no declared dependencies.
        assert!(check(&s(&["mine"]), &["mine"]).is_ok());
    }
}
