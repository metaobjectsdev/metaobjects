//! The `cargo meta` command.
//!
//! Cargo runs `cargo-<name>` for `cargo <name>` and passes `<name>` as the first argument, so
//! the binary accepts both `cargo-meta meta gen` (how cargo calls it) and `cargo-meta gen`.
//! The commands are written against `Write` handles so they run in tests without a process.
//!
//! The command line follows the contract the other ports' tools share
//! (`docs/features/cli.md`): exit 0 on success, 1 when the run failed (a model that does not
//! load, a refused file, drift), 2 for a usage error; an unknown flag names the flags the
//! command takes; `--version` prints the bare version.
//!
//! A project that owns generators (`cargo meta eject`) has a `codegen/` crate. `gen` and
//! `verify` build and run that crate instead of the shipped generators, and the crate calls
//! back into [`owned_main`], so both paths are this one command line.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

use metaobjects::collection::discover_collection_root;
use metaobjects::rules_check::Severity;
use metaobjects::timing::{LoadTimings, ms, render_table};
use metaobjects_codegen::eject::{self, CopyState, EjectError, EngineSource};
use metaobjects_codegen::engine::{
    ChangeKind, OWNED_MANIFEST, Outcome, RunError, RunOptions, RunReport, VerifyReport,
};
use metaobjects_codegen::generator_list::{self, GENERATOR_LIST_FILE};
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::{Generator, run, shipped_generators, verify};

pub mod templates;

/// The tool's name in messages.
const TOOL: &str = "cargo meta";

const USAGE: &str = "\
cargo meta: MetaObjects for Rust

USAGE:
    cargo meta init   [--project <dir>]
    cargo meta gen    [OPTIONS] [ENTITY...]
    cargo meta verify [--codegen] [--templates] [--full] [OPTIONS]
    cargo meta eject  <generator>... [--force] [--engine <source>]
    cargo meta eject  --undo [<generator>...] [--force]
    cargo meta eject  --list

COMMANDS:
    init       Scaffold a project: .metaobjects/config.json, a first metadata file, the
               ignore rules for the generation state and metaobjects.config.json, the list of
               generators to run. Writes only what is missing.
    gen        Generate Rust crates from the project's model. Skips the whole run when the
               model, the project config and the generators are unchanged; writes only files
               whose bytes changed; removes a generated file nothing emits any more; refuses
               to overwrite or delete a generated file that was edited by hand.
    verify     Check that the generated crates are what `gen` would write, in memory and
               without writing anything, that every template body matches the payload it
               renders over, and the business rules. Exits 1 on drift.
    eject      Copy a shipped generator into codegen/generators/ to own and change.
               --undo takes back copies that are still identical to the shipped generator.
               The owned crate builds against this release of the engine from crates.io;
               --engine <dir | git-url[#rev]> names a checkout or a git revision instead.

OPTIONS (gen and verify):
    --project <dir>      The project root (the directory holding .metaobjects/config.json).
                         Default: the nearest one at or above the current directory.
    --out <dir>          Where the crates are written, relative to the project root and
                         a sub-directory of it. Default: generated
    --generators <a,b>   Run only these generators, from the project's list
                         (`cargo meta gen --list` shows both).
    --strict             Load strictly: an attribute no provider declares is an error
                         Off by default here, unlike the other ports' `verify`: the Rust
                         generated-code skip key records the load mode `gen` used.
    --timings            Print the time spent in each stage.

OPTIONS (gen):
    --force              Render and compare even when nothing changed.
    --list               List the generators: which the project's list runs, and how each
                         owned copy compares.

OPTIONS (verify):
    --codegen            The generated-code gate only: no business-rules gate.
    --templates          The template gate only: each template.* body against its payload
                         value object (unknown variables, unresolved partials, missing
                         required tags and slots) and each prompt's reply (@responseRef).
                         A bare `verify` runs every gate; naming one or both runs only those.
    --prompts <dir>      Where template bodies live, relative to the project root.
                         Default: prompts
    --full               Render and compare even when a local run could answer from the
                         stored key. Always on when CI is set.

OPTIONS (everywhere):
    -h, --help           Print this help.
    -V, --version        Print the version.

GENERATORS: a project chooses what runs in metaobjects.config.json, `{ \"generators\": [..] }`,
by name. Edit the list; no eject is needed. With no such file every generator runs.

ENTITY names limit `gen` to the crates that contain them plus the crates those depend on.
Such a run never skips, never stores the skip key and never removes a file.

Schema migrations and database checks are not part of this tool: they are the Node `meta`
command's (`meta migrate`, `meta verify --db`) for every server language.

EXIT STATUS: 0 success; 1 the run failed; 2 usage error.
";

/// A command-line mistake: exit 2.
#[derive(Debug, PartialEq)]
struct Usage(String);

/// One flag a command takes.
struct Flag {
    name: &'static str,
    value: bool,
}

const fn switch(name: &'static str) -> Flag {
    Flag { name, value: false }
}

const fn valued(name: &'static str) -> Flag {
    Flag { name, value: true }
}

const INIT_FLAGS: &[Flag] = &[valued("--project")];
const GEN_FLAGS: &[Flag] = &[
    switch("--force"),
    valued("--generators"),
    switch("--list"),
    valued("--out"),
    valued("--project"),
    switch("--strict"),
    switch("--timings"),
];
const VERIFY_FLAGS: &[Flag] = &[
    switch("--codegen"),
    switch("--db"),
    switch("--deps"),
    switch("--full"),
    valued("--generators"),
    valued("--out"),
    valued("--project"),
    valued("--prompts"),
    switch("--strict"),
    switch("--templates"),
    switch("--timings"),
];
const EJECT_FLAGS: &[Flag] = &[
    valued("--engine"),
    switch("--force"),
    switch("--list"),
    valued("--project"),
    switch("--undo"),
];

/// A command's arguments, split into its flags and its positional words.
#[derive(Debug, Default)]
struct Split {
    flags: Vec<(&'static str, Option<String>)>,
    words: Vec<String>,
}

impl Split {
    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(n, _)| *n == name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .and_then(|(_, v)| v.as_deref())
    }
}

/// The message every port's tool gives for a flag its command does not take.
fn unknown_flag(flag: &str, command: &str, flags: &[Flag]) -> Usage {
    let mut valid: Vec<&str> = flags.iter().map(|f| f.name).collect();
    valid.sort_unstable();
    Usage(format!(
        "unknown flag {flag} for `{TOOL} {command}`. Valid flags: {} (also accepted everywhere: --help)",
        valid.join(", ")
    ))
}

fn split(args: &[String], command: &str, flags: &[Flag]) -> Result<Split, Usage> {
    let mut out = Split::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if !arg.starts_with('-') || arg == "-" {
            out.words.push(arg.clone());
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (arg.as_str(), None),
        };
        let Some(flag) = flags.iter().find(|f| f.name == name) else {
            return Err(unknown_flag(name, command, flags));
        };
        let value = match (flag.value, inline) {
            (true, Some(v)) => Some(v),
            (true, None) => Some(
                it.next()
                    .cloned()
                    .ok_or_else(|| Usage(format!("{name} needs a value")))?,
            ),
            (false, Some(_)) => return Err(Usage(format!("{name} takes no value"))),
            (false, None) => None,
        };
        out.flags.push((flag.name, value));
    }
    Ok(out)
}

fn names(list: &str) -> Vec<String> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The run options the `gen` and `verify` flags describe.
fn run_options(
    s: &Split,
    cwd: &Path,
    generators: &[Box<dyn Generator>],
) -> Result<RunOptions, Usage> {
    let mut options = RunOptions::new(cwd);
    options.project_dir = s.value("--project").map(PathBuf::from);
    if let Some(out) = s.value("--out") {
        options.out_dir = PathBuf::from(out);
    }
    options.strict = s.has("--strict");
    if let Some(list) = s.value("--generators") {
        let wanted = names(list);
        let known: Vec<&str> = generators.iter().map(|g| g.name()).collect();
        if let Some(bad) = wanted.iter().find(|n| !known.contains(&n.as_str())) {
            return Err(Usage(format!(
                "unknown generator {bad}; available: {}",
                known.join(", ")
            )));
        }
        options.generators = Some(wanted);
    }
    Ok(options)
}

/// The project a command addresses: `--project`, or the nearest one at or above `cwd`.
fn project_root(s: &Split, cwd: &Path) -> PathBuf {
    match s.value("--project") {
        Some(dir) if Path::new(dir).is_absolute() => PathBuf::from(dir),
        Some(dir) => cwd.join(dir),
        None => discover_collection_root(cwd).dir,
    }
}

fn stage_rows(t: &LoadTimings) -> Vec<(String, f64)> {
    t.phases
        .iter()
        .map(|x| (x.name.to_string(), ms(x.duration)))
        .collect()
}

fn print_warnings(err: &mut dyn Write, warnings: &[String]) {
    for w in warnings {
        let _ = writeln!(err, "warning: {w}");
    }
}

fn print_timings(out: &mut dyn Write, t: &LoadTimings) {
    let _ = writeln!(out);
    let _ = write!(out, "{}", render_table("stage", &stage_rows(t), None));
}

fn report_summary(r: &RunReport) -> String {
    let total = ms(r.timings.total());
    match r.outcome {
        Outcome::Skipped => {
            format!("gen: skipped, nothing changed since the last run ({total:.1} ms)")
        }
        Outcome::Generated => {
            let f = &r.files;
            let mut parts = vec![
                format!("{} created", f.created),
                format!("{} updated", f.overwritten),
                format!("{} unchanged", f.unchanged),
            ];
            if f.removed > 0 {
                parts.push(format!("{} removed", f.removed));
            }
            let total_files = f.created + f.overwritten + f.unchanged;
            format!(
                "gen: {total_files} files ({}) in {total:.1} ms{}",
                parts.join(", "),
                match r.no_skip_reason {
                    Some(why) => format!("; did not skip: {why}"),
                    None => String::new(),
                }
            )
        }
    }
}

/// How many changed files the change report names before it counts the rest.
const CHANGES_SHOWN: usize = 20;

/// The change report: what the run created, rewrote and removed, and which crates a build
/// has to look at again. Every other crate is byte-identical, so cargo will not rebuild it.
fn change_report(r: &RunReport) -> Vec<String> {
    let mut lines = Vec::new();
    for c in r.changes.iter().take(CHANGES_SHOWN) {
        let verb = match c.kind {
            ChangeKind::Created => "created",
            ChangeKind::Updated => "updated",
            ChangeKind::Removed => "removed",
        };
        lines.push(format!("  {verb} {}", c.path));
    }
    if r.changes.len() > CHANGES_SHOWN {
        lines.push(format!(
            "  ... and {} more",
            r.changes.len() - CHANGES_SHOWN
        ));
    }
    // A crate whose every file was removed is gone, not something to build.
    let live: Vec<String> = r
        .changed_roots()
        .into_iter()
        .filter(|root| {
            r.project_root
                .join(&r.out_rel)
                .join(root)
                .join("Cargo.toml")
                .is_file()
        })
        .collect();
    if !live.is_empty() {
        lines.push(format!(
            "changed crates: {} (cargo check -p {})",
            live.join(", "),
            live.join(" -p ")
        ));
    }
    lines
}

/// One line naming the owned copies that are still the shipped generator, if any.
fn unchanged_copy_notice(project_root: &Path) -> Option<String> {
    let identical: Vec<&str> = eject::owned_copies(project_root)
        .iter()
        .filter(|c| c.state == CopyState::Identical)
        .map(|c| c.reference.name)
        .collect();
    (!identical.is_empty()).then(|| {
        format!(
            "note: the owned copy of {} is identical to the shipped generator; `{TOOL} eject --undo` takes it back.",
            identical.join(", ")
        )
    })
}

/// `gen --list`: every generator, whether the project's list runs it, and how an owned copy
/// compares. Returns the exit status: 1 when the project's list cannot be used.
fn list_generators(
    out: &mut dyn Write,
    err: &mut dyn Write,
    root: &Path,
    generators: &[Box<dyn Generator>],
) -> i32 {
    let listed = match generator_list::read(root) {
        Ok(listed) => listed.as_deref().map(generator_list::names),
        Err(e) => {
            let _ = writeln!(err, "{TOOL}: {e}");
            return 1;
        }
    };
    let owns = eject::owns_generators(root);
    let mut available: Vec<&str> = eject::REFERENCES.iter().map(|r| r.name).collect();
    for g in generators {
        if !available.contains(&g.name()) {
            available.push(g.name());
        }
    }
    let mut status = 0;
    match &listed {
        None => {
            let _ = writeln!(
                out,
                "No {GENERATOR_LIST_FILE}: every generator runs. `{TOOL} init` writes one to choose from."
            );
        }
        Some(names) => {
            let _ = writeln!(
                out,
                "{GENERATOR_LIST_FILE} runs: {}",
                if names.is_empty() {
                    "nothing (the list is empty)".to_string()
                } else {
                    names.join(", ")
                }
            );
            // An owned crate may carry generators this command cannot see without building it.
            if !owns && let Err(e) = generator_list::check(names, &available) {
                let _ = writeln!(err, "{TOOL}: {e}");
                status = 1;
            }
        }
    }
    let on = |name: &str| match &listed {
        None => String::new(),
        Some(names) if names.iter().any(|n| n == name) => " [configured]".to_string(),
        Some(_) => " [not configured]".to_string(),
    };
    let copies = eject::owned_copies(root);
    for r in eject::REFERENCES {
        let state = match copies.iter().find(|c| c.reference == r) {
            Some(c) => format!(" [owned: {}]", c.state),
            None => String::new(),
        };
        let _ = writeln!(
            out,
            "{} - {} (layer: {}){}{state}",
            r.name,
            r.summary,
            r.layer,
            on(r.name)
        );
    }
    for g in generators {
        if eject::reference(g.name()).is_none() {
            let _ = writeln!(
                out,
                "{} - a generator of this project{}",
                g.name(),
                on(g.name())
            );
        }
    }
    status
}

fn cmd_gen(
    args: &[String],
    cwd: &Path,
    generators: &[Box<dyn Generator>],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, Usage> {
    let s = split(args, "gen", GEN_FLAGS)?;
    if s.has("--list") {
        return Ok(list_generators(
            out,
            err,
            &project_root(&s, cwd),
            generators,
        ));
    }
    let mut options = run_options(&s, cwd, generators)?;
    options.force = s.has("--force");
    options.entities = s.words.clone();
    match run(&options, generators) {
        Ok(report) => {
            print_warnings(err, &report.warnings);
            let _ = writeln!(out, "{}", report_summary(&report));
            for line in change_report(&report) {
                let _ = writeln!(out, "{line}");
            }
            if let Some(note) = unchanged_copy_notice(&report.project_root) {
                let _ = writeln!(out, "{note}");
            }
            if s.has("--timings") {
                print_timings(out, &report.timings);
            }
            Ok(0)
        }
        Err(e) => {
            let _ = writeln!(err, "{TOOL} gen failed:\n{e}");
            if matches!(e, RunError::Load(_)) {
                let _ = writeln!(err, "\nNothing was written.");
            }
            Ok(1)
        }
    }
}

/// `CI` set to anything but the empty string makes `verify` render (ADR-0064): a build
/// server never answers from a key a developer's machine stored.
fn ci_forces_render(ci: Option<OsString>) -> bool {
    ci.is_some_and(|v| !v.is_empty())
}

fn verify_lines(r: &VerifyReport) -> (Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    if r.in_sync() {
        out.push(if r.rendered {
            format!("{TOOL} verify: in sync ({} file(s)).", r.checked)
        } else {
            format!(
                "{TOOL} verify: in sync (the model and every recorded file are unchanged since the last gen; pass --full to render and compare)."
            )
        });
        return (out, err);
    }
    err.push("error: generated code is out of sync with metadata.".to_string());
    for k in &r.drifted {
        err.push(format!("  drifted: {k}"));
    }
    for k in &r.missing {
        err.push(format!("  missing: {k}"));
    }
    for x in &r.extra {
        err.push(if x.edited {
            format!(
                "  extra:   {} (no generator emits it any more, and it was edited by hand)",
                x.path
            )
        } else {
            format!(
                "  extra:   {} (no generator emits it any more; gen deletes it)",
                x.path
            )
        });
    }
    err.push(format!("regenerate ({TOOL} gen) and commit the result."));
    if r.extra.iter().any(|x| x.edited) {
        err.push(format!(
            "For the extra file(s) edited by hand, `{TOOL} gen` will NOT delete them: delete each one, or move your edits into a file of your own first."
        ));
    }
    (out, err)
}

/// The rules gate's lines (all on stderr, as the other ports print them): nothing for a
/// model that declares no operation and no transition, else the summary, every finding and,
/// when any is an error, the count.
fn rules_lines(r: &VerifyReport) -> Vec<String> {
    let Some(s) = r.rules.summary else {
        return Vec::new();
    };
    let mut lines = vec![format!(
        "{TOOL} verify — rules: {} operation(s), {} lifecycle(s) with {} transition(s).",
        s.operations, s.lifecycles, s.transitions
    )];
    let errors = r.rules.errors().count();
    // Errors first, then warnings, each in the order the gate found them.
    for severity in [Severity::Error, Severity::Warn] {
        for d in r
            .rules
            .diagnostics
            .iter()
            .filter(|d| d.severity == severity)
        {
            lines.push(format!("  {} [{}]: {}", d.code, d.path, d.message));
        }
    }
    if errors > 0 {
        lines.push(format!("{TOOL} verify — rules: {errors} error(s)."));
    }
    lines
}

fn cmd_verify(
    args: &[String],
    cwd: &Path,
    generators: &[Box<dyn Generator>],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, Usage> {
    let s = split(args, "verify", VERIFY_FLAGS)?;
    if let Some(word) = s.words.first() {
        return Err(Usage(format!(
            "`{TOOL} verify` takes no argument (got {word})"
        )));
    }
    if s.has("--db") {
        return Err(Usage(format!(
            "`{TOOL} verify --db` does not exist: checking a schema against a live database is the Node `meta` command's for every server language (`meta verify --db`, ADR-0015)."
        )));
    }
    if s.has("--deps") {
        return Err(Usage(format!(
            "`{TOOL} verify --deps` does not exist: metadata dependencies are resolved and checked by the Node `meta` command (`meta deps check`)."
        )));
    }
    let mut options = run_options(&s, cwd, generators)?;
    options.force = s.has("--full") || ci_forces_render(std::env::var_os("CI"));
    // Naming a gate runs only the named ones; a bare `verify` runs them all.
    let named = s.has("--codegen") || s.has("--templates");
    let mut code = 0;
    if s.has("--codegen") || !named {
        code = verify_codegen(&s, &options, generators, out, err);
    }
    if s.has("--templates") || !named {
        let prompts = s.value("--prompts").map(PathBuf::from);
        code = code.max(verify_templates(
            &options,
            prompts.as_deref(),
            s.has("--templates"),
            out,
            err,
        ));
    }
    Ok(code)
}

/// The template gate: load the project and check every template body and reply.
fn verify_templates(
    options: &RunOptions,
    prompts: Option<&Path>,
    announce_empty: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let project = match load_project(
        &options.start_dir,
        options.project_dir.as_deref(),
        options.strict,
    ) {
        Ok(p) => p,
        Err(errors) => {
            let lines: Vec<String> = errors.iter().map(ToString::to_string).collect();
            let _ = writeln!(err, "{TOOL} verify failed:\n{}", lines.join("\n"));
            return 1;
        }
    };
    let root = &project.collection.config_dir;
    let dir = root.join(prompts.unwrap_or_else(|| Path::new(templates::DEFAULT_PROMPTS_DIR)));
    templates::run(&project, &dir, TOOL, announce_empty, out, err)
}

/// The generated-code gate, and (on a bare `verify`) the rules gate.
fn verify_codegen(
    s: &Split,
    options: &RunOptions,
    generators: &[Box<dyn Generator>],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match verify(options, generators) {
        Ok(report) => {
            print_warnings(err, &report.warnings);
            let (to_out, to_err) = verify_lines(&report);
            for line in to_out {
                let _ = writeln!(out, "{line}");
            }
            for line in to_err {
                let _ = writeln!(err, "{line}");
            }
            let rules = !s.has("--codegen") && !s.has("--templates");
            if rules {
                for line in rules_lines(&report) {
                    let _ = writeln!(err, "{line}");
                }
            }
            if s.has("--timings") {
                print_timings(out, &report.timings);
            }
            if report.in_sync() && !(rules && report.rules_failed()) {
                0
            } else {
                1
            }
        }
        Err(e) => {
            let _ = writeln!(err, "{TOOL} verify failed:\n{e}");
            1
        }
    }
}

fn cmd_eject(
    args: &[String],
    cwd: &Path,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, Usage> {
    let s = split(args, "eject", EJECT_FLAGS)?;
    let engine = s
        .value("--engine")
        .map_or_else(EngineSource::default, EngineSource::parse);
    let root = project_root(&s, cwd);
    if s.has("--list") {
        return Ok(list_generators(out, err, &root, &[]));
    }
    let result = if s.has("--undo") {
        eject::undo(&root, &s.words, s.has("--force"))
    } else {
        eject::eject(&root, &s.words, s.has("--force"), &engine)
    };
    match result {
        Ok(lines) => {
            for line in lines {
                let _ = writeln!(out, "{line}");
            }
            Ok(0)
        }
        Err(EjectError::Usage(m)) => Err(Usage(m)),
        Err(e) => {
            let _ = writeln!(err, "{TOOL} eject: {e}");
            Ok(e.exit_code())
        }
    }
}

/// What `init` writes when it is missing: a path from the project root and its text.
fn init_files() -> [(&'static str, String); 4] {
    [
        (
            ".metaobjects/config.json",
            "{\n  \"schema_version\": 1,\n  \"migrate\": {\n    \"foreignKeyIndexes\": true\n  },\n  \"verify\": {\n    \"handEdits\": \"fail\"\n  },\n  \"api\": {\n    \"pagination\": {\n      \"defaultLimit\": 50,\n      \"maxLimit\": 1000\n    },\n    \"unknownFields\": \"reject\"\n  }\n}\n".to_string(),
        ),
        (
            ".metaobjects/.gitignore",
            "# The generation state. `.hashes/` is committed: it is one hash per generated\n# path (one file per model package), and the only thing that lets `gen` tell \"this file is exactly what I wrote\" from\n# \"somebody edited this\" on a machine that did not generate it. Everything else here (the\n# skip key) describes one machine's last run and is not.\n#\n# The glob form matters: `.gen-state/` (a directory) would stop git descending, and the\n# negation below could never take effect.\n.gen-state/*\n!.gen-state/.hashes/\n".to_string(),
        ),
        (
            "metaobjects/meta.app.yaml",
            "metadata:\n  package: app\n  children: []\n".to_string(),
        ),
    (GENERATOR_LIST_FILE, generator_list::scaffold()),
    ]
}

fn cmd_init(
    args: &[String],
    cwd: &Path,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, Usage> {
    let s = split(args, "init", INIT_FLAGS)?;
    if let Some(word) = s.words.first() {
        return Err(Usage(format!(
            "`{TOOL} init` takes no argument (got {word}); name the directory with --project"
        )));
    }
    // `init` creates the project marker, so it never walks up looking for one.
    let root = match s.value("--project") {
        Some(dir) if Path::new(dir).is_absolute() => PathBuf::from(dir),
        Some(dir) => cwd.join(dir),
        None => cwd.to_path_buf(),
    };
    // A project that already keeps its metadata somewhere is not given a second, empty file.
    let has_metadata = std::fs::read_dir(root.join("metaobjects"))
        .map(|d| d.filter_map(Result::ok).next().is_some())
        .unwrap_or(false);
    for (rel, text) in init_files() {
        let path = root.join(rel);
        if path.exists() {
            let _ = writeln!(out, "kept {rel} (already exists)");
            continue;
        }
        if rel.starts_with("metaobjects/") && has_metadata {
            let _ = writeln!(out, "kept metaobjects/ (already holds metadata)");
            continue;
        }
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, text));
        if let Err(e) = written {
            let _ = writeln!(err, "{TOOL} init: writing {}: {e}", path.display());
            return Ok(1);
        }
        let _ = writeln!(out, "wrote {rel}");
    }
    let _ = writeln!(
        out,
        "next: declare your objects in metaobjects/ (JSON or YAML), then run `{TOOL} gen`.\n\
         Choose the generators `gen` runs by editing {GENERATOR_LIST_FILE}.\n\
         Commit .metaobjects/.gen-state/.hashes/ with the generated crates.\n\
         Schema migrations are the Node `meta` command's (`meta migrate`), for every server language."
    );
    Ok(0)
}

/// Who is running the command line.
enum Host {
    /// `cargo-meta` itself, with the shipped generators.
    Shipped,
    /// A project's `codegen/` crate, with the generator list it declares.
    Owned,
}

/// What this command exits with when the project's `codegen/` crate exited with `code`
/// (`None`: a signal ended it). The owned crate runs this same command line, so 0, 1 and 2
/// are its answers and pass through. Anything else is a build that failed or a generator
/// that panicked (cargo and a panic both exit 101), and that is a failure, 1: the documented
/// codes are 0, 1 and 2, and a script reading them must not meet a fourth.
pub fn owned_exit_code(code: Option<i32>) -> i32 {
    match code {
        Some(0) => 0,
        Some(2) => 2,
        _ => 1,
    }
}

/// Build and run the project's `codegen/` crate with the same arguments. Its exit status is
/// this command's, held to 0, 1 or 2 by [`owned_exit_code`].
fn hand_off(project: &Path, rest: &[String], cwd: &Path, err: &mut dyn Write) -> i32 {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    let status = std::process::Command::new(cargo)
        .arg("run")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg(project.join(OWNED_MANIFEST))
        .arg("--")
        .args(rest)
        .current_dir(cwd)
        .status();
    match status {
        Ok(s) => owned_exit_code(s.code()),
        Err(e) => {
            let _ = writeln!(
                err,
                "{TOOL}: this project owns its generators ({OWNED_MANIFEST}), and running them failed: {e}"
            );
            1
        }
    }
}

fn dispatch(
    args: &[String],
    cwd: &Path,
    generators: &[Box<dyn Generator>],
    host: &Host,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut rest = args;
    if rest.first().map(String::as_str) == Some("meta") {
        rest = &rest[1..];
    }
    if rest.iter().any(|a| a == "-h" || a == "--help") || rest.first().is_some_and(|a| a == "help")
    {
        let _ = write!(out, "{USAGE}");
        return 0;
    }
    let Some((command, tail)) = rest.split_first() else {
        let _ = writeln!(err, "{TOOL}: missing command: try `{TOOL} gen`\n\n{USAGE}");
        return 2;
    };
    if matches!(command.as_str(), "-V" | "-v" | "--version") {
        let _ = writeln!(out, "{}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let result = match (command.as_str(), host) {
        ("gen" | "verify", Host::Shipped) => {
            // Owned generators are a build of the project's own crate. `--list` reads files
            // and needs no build.
            let flags = if command == "gen" {
                GEN_FLAGS
            } else {
                VERIFY_FLAGS
            };
            match split(tail, command, flags) {
                Err(usage) => Err(usage),
                Ok(s) => {
                    let project = project_root(&s, cwd);
                    if eject::owns_generators(&project) && !s.has("--list") {
                        return hand_off(&project, rest, cwd, err);
                    }
                    if command == "gen" {
                        cmd_gen(tail, cwd, generators, out, err)
                    } else {
                        cmd_verify(tail, cwd, generators, out, err)
                    }
                }
            }
        }
        ("gen", Host::Owned) => cmd_gen(tail, cwd, generators, out, err),
        ("verify", Host::Owned) => cmd_verify(tail, cwd, generators, out, err),
        ("init", Host::Shipped) => cmd_init(tail, cwd, out, err),
        ("eject", Host::Shipped) => cmd_eject(tail, cwd, out, err),
        ("init" | "eject", Host::Owned) => Err(Usage(format!(
            "`{command}` is not a command of a project's codegen crate; run `{TOOL} {command}`"
        ))),
        (flag, _) if flag.starts_with('-') => Err(Usage(format!(
            "unknown flag {flag}. A flag follows its command: `{TOOL} gen {flag}`"
        ))),
        (other, _) => Err(Usage(format!("unknown command {other}"))),
    };
    match result {
        Ok(code) => code,
        Err(Usage(msg)) => {
            let _ = writeln!(
                err,
                "{TOOL}: {msg}\n\nRun `{TOOL} --help` for the commands and their flags."
            );
            2
        }
    }
}

/// Run the command line with the shipped generators. Returns the process exit status.
pub fn main_with(args: &[String], cwd: &Path, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    dispatch(args, cwd, &shipped_generators(), &Host::Shipped, out, err)
}

/// The command line of a project's `codegen/` crate: `gen` and `verify` over the generator
/// list that crate declares. Reads the process arguments and returns the exit status.
pub fn owned_main(generators: Vec<Box<dyn Generator>>) -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("{TOOL}: cannot read the current directory: {e}");
            return 1;
        }
    };
    owned_main_with(
        &args,
        &cwd,
        &generators,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    )
}

/// [`owned_main`] against explicit arguments and handles.
pub fn owned_main_with(
    args: &[String],
    cwd: &Path,
    generators: &[Box<dyn Generator>],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    dispatch(args, cwd, generators, &Host::Owned, out, err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    fn run_cli(list: &[&str]) -> (i32, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = main_with(
            &args(list),
            Path::new("/nonexistent-project"),
            &mut out,
            &mut err,
        );
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn flags_split_from_words_in_either_spelling() {
        let s = split(
            &args(&[
                "--out",
                "crates",
                "Order",
                "--generators=entity,client",
                "--force",
                "Line",
            ]),
            "gen",
            GEN_FLAGS,
        )
        .unwrap();
        assert_eq!(s.value("--out"), Some("crates"));
        assert_eq!(s.value("--generators"), Some("entity,client"));
        assert!(s.has("--force") && !s.has("--strict"));
        assert_eq!(s.words, vec!["Order".to_string(), "Line".to_string()]);
    }

    #[test]
    fn an_unknown_flag_names_the_command_and_its_valid_flags() {
        let e = split(&args(&["--bogus"]), "gen", GEN_FLAGS).unwrap_err();
        assert_eq!(
            e.0,
            "unknown flag --bogus for `cargo meta gen`. Valid flags: --force, --generators, --list, --out, --project, --strict, --timings (also accepted everywhere: --help)"
        );
        assert!(
            split(&args(&["--out"]), "gen", GEN_FLAGS).is_err(),
            "a value is required"
        );
        assert!(
            split(&args(&["--force=yes"]), "gen", GEN_FLAGS).is_err(),
            "a switch takes none"
        );
        // A flag of another command is unknown here.
        assert!(split(&args(&["--full"]), "gen", GEN_FLAGS).is_err());
        assert!(split(&args(&["--force"]), "verify", VERIFY_FLAGS).is_err());
    }

    #[test]
    fn usage_errors_exit_2_help_exits_0_and_version_is_bare() {
        assert_eq!(run_cli(&["meta"]).0, 2);
        assert_eq!(run_cli(&["meta", "frobnicate"]).0, 2);
        assert_eq!(run_cli(&["meta", "gen", "--bogus"]).0, 2);
        assert_eq!(run_cli(&["meta", "gen", "--generators", "nope"]).0, 2);
        assert_eq!(run_cli(&["meta", "verify", "extra-word"]).0, 2);
        assert_eq!(
            run_cli(&["meta", "eject"]).0,
            2,
            "eject needs a name or --undo"
        );
        assert_eq!(run_cli(&["meta", "eject", "nope"]).0, 2);
        let (code, out, _) = run_cli(&["meta", "--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("cargo meta gen") && out.contains("cargo meta verify"));
        assert_eq!(
            run_cli(&["gen", "--help"]).0,
            0,
            "--help is accepted everywhere"
        );
        for flag in ["--version", "-V", "-v"] {
            let (code, out, _) = run_cli(&["meta", flag]);
            assert_eq!(
                (code, out.as_str()),
                (0, concat!(env!("CARGO_PKG_VERSION"), "\n"))
            );
        }
    }

    #[test]
    fn the_gates_this_port_does_not_ship_say_where_they_live() {
        let (code, _, err) = run_cli(&["meta", "verify", "--db"]);
        assert_eq!(code, 2);
        assert!(err.contains("meta verify --db"), "{err}");
        assert_eq!(run_cli(&["meta", "verify", "--deps"]).0, 2);
    }

    #[test]
    fn ci_forces_a_render_unless_it_is_empty() {
        assert!(ci_forces_render(Some(OsString::from("true"))));
        assert!(ci_forces_render(Some(OsString::from("1"))));
        assert!(!ci_forces_render(Some(OsString::new())));
        assert!(!ci_forces_render(None));
    }

    #[test]
    fn the_owned_command_line_refuses_the_commands_that_are_not_its() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = owned_main_with(
            &args(&["eject", "entity"]),
            Path::new("/p"),
            &[],
            &mut out,
            &mut err,
        );
        assert_eq!(code, 2);
        assert!(String::from_utf8(err).unwrap().contains("cargo meta eject"));
    }
}
