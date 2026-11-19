//! The `cargo meta` command (preview).
//!
//! Cargo runs `cargo-<name>` for `cargo <name>` and passes `<name>` as the first argument, so
//! the binary accepts both `cargo-meta meta gen` (how cargo calls it) and `cargo-meta gen`.
//! The commands are written against `Write` handles so they run in tests without a process.

use std::io::Write;
use std::path::{Path, PathBuf};

use metaobjects::timing::{LoadTimings, ms, render_table};
use metaobjects_codegen::engine::{Outcome, RunError, RunOptions, RunReport};
use metaobjects_codegen::{EntityGenerator, Generator, run};

const USAGE: &str = "\
cargo meta: MetaObjects for Rust (preview)

USAGE:
    cargo meta gen [OPTIONS] [ENTITY...]

COMMANDS:
    gen        Generate Rust crates (one per metadata package) from the project's model.
               Skips the whole run when the model, the project config and the generators
               are unchanged; writes only files whose bytes changed.

OPTIONS:
    --project <dir>      The project root (the directory holding .metaobjects/config.json).
                         Default: the nearest one at or above the current directory.
    --out <dir>          Where the crates are written, relative to the project root and
                         inside it. Default: generated
    --generators <a,b>   Run only these generators. Available: entity
    --strict             Load strictly: an attribute no provider declares is an error.
    --force              Render and compare even when nothing changed.
    --timings            Print the time spent in each stage (load, plan, skip, render, write).
    -h, --help           Print this help.
    -V, --version        Print the version.

ENTITY names limit the run to the packages that contain them. Such a run never skips and
never stores the skip key.

EXIT STATUS: 0 success; 1 the run failed; 2 usage error.
";

/// The generators `cargo meta gen` runs.
fn generators() -> Vec<Box<dyn Generator>> {
    vec![Box::new(EntityGenerator)]
}

/// Parsed `gen` arguments.
#[derive(Debug, PartialEq)]
struct GenArgs {
    options: RunOptions,
    timings: bool,
}

#[derive(Debug, PartialEq)]
enum Parsed {
    Help,
    Version,
    Gen(Box<GenArgs>),
}

fn parse(args: &[String], cwd: &Path) -> Result<Parsed, String> {
    let mut rest = args;
    if rest.first().map(String::as_str) == Some("meta") {
        rest = &rest[1..];
    }
    let mut options = RunOptions::new(cwd);
    let mut timings = false;
    let mut command = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let mut value = |flag: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match a.as_str() {
            "-h" | "--help" | "help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--project" => options.project_dir = Some(PathBuf::from(value("--project")?)),
            "--out" => options.out_dir = PathBuf::from(value("--out")?),
            "--generators" => {
                let v = value("--generators")?;
                options.generators = Some(
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect(),
                );
            }
            "--strict" => options.strict = true,
            "--force" => options.force = true,
            "--timings" => timings = true,
            flag if flag.starts_with('-') => return Err(format!("unknown option {flag}")),
            word if command.is_none() => command = Some(word.to_string()),
            entity => options.entities.push(entity.to_string()),
        }
    }
    match command.as_deref() {
        Some("gen") => {}
        Some(other) => return Err(format!("unknown command {other}")),
        None => return Err("missing command: try `cargo meta gen`".to_string()),
    }
    if let Some(names) = &options.generators {
        let known: Vec<String> = generators().iter().map(|g| g.name().to_string()).collect();
        for n in names {
            if !known.contains(n) {
                return Err(format!(
                    "unknown generator {n}; available: {}",
                    known.join(", ")
                ));
            }
        }
    }
    Ok(Parsed::Gen(Box::new(GenArgs { options, timings })))
}

fn stage_rows(t: &LoadTimings) -> Vec<(String, f64)> {
    t.phases
        .iter()
        .map(|x| (x.name.to_string(), ms(x.duration)))
        .collect()
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

/// Run the command line. Returns the process exit status.
pub fn main_with(args: &[String], cwd: &Path, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let parsed = match parse(args, cwd) {
        Ok(p) => p,
        Err(msg) => {
            let _ = writeln!(err, "cargo meta: {msg}\n\n{USAGE}");
            return 2;
        }
    };
    let gen_args = match parsed {
        Parsed::Help => {
            let _ = write!(out, "{USAGE}");
            return 0;
        }
        Parsed::Version => {
            let _ = writeln!(out, "cargo-meta {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        Parsed::Gen(a) => *a,
    };
    match run(&gen_args.options, &generators()) {
        Ok(report) => {
            for w in &report.warnings {
                let _ = writeln!(err, "warning: {w}");
            }
            let _ = writeln!(out, "{}", report_summary(&report));
            if gen_args.timings {
                let _ = writeln!(out);
                let _ = write!(
                    out,
                    "{}",
                    render_table("stage", &stage_rows(&report.timings), None)
                );
            }
            0
        }
        Err(e) => {
            let _ = writeln!(err, "cargo meta gen failed:\n{e}");
            if matches!(e, RunError::Load(_)) {
                let _ = writeln!(err, "\nNothing was written.");
            }
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    fn gen_options(list: &[&str]) -> GenArgs {
        match parse(&args(list), Path::new("/p")).expect("parses") {
            Parsed::Gen(a) => *a,
            other => panic!("not a gen command: {other:?}"),
        }
    }

    #[test]
    fn cargo_passes_the_subcommand_name_first_and_both_spellings_parse() {
        let a = gen_options(&["meta", "gen", "--force", "Order"]);
        let b = gen_options(&["gen", "--force", "Order"]);
        assert_eq!(a, b);
        assert!(a.options.force);
        assert_eq!(a.options.entities, vec!["Order".to_string()]);
    }

    #[test]
    fn flags_with_values_parse() {
        let a = gen_options(&[
            "meta",
            "gen",
            "--out",
            "crates",
            "--project",
            "app",
            "--generators",
            "entity",
            "--timings",
            "--strict",
        ]);
        assert_eq!(a.options.out_dir, PathBuf::from("crates"));
        assert_eq!(a.options.project_dir, Some(PathBuf::from("app")));
        assert_eq!(a.options.generators, Some(vec!["entity".to_string()]));
        assert!(a.timings && a.options.strict);
    }

    #[test]
    fn bad_input_is_a_usage_error() {
        assert!(parse(&args(&["meta"]), Path::new("/p")).is_err());
        assert!(parse(&args(&["meta", "verify"]), Path::new("/p")).is_err());
        assert!(parse(&args(&["meta", "gen", "--bogus"]), Path::new("/p")).is_err());
        assert!(parse(&args(&["meta", "gen", "--out"]), Path::new("/p")).is_err());
        assert!(
            parse(
                &args(&["meta", "gen", "--generators", "nope"]),
                Path::new("/p")
            )
            .is_err()
        );
        assert_eq!(
            parse(&args(&["meta", "--help"]), Path::new("/p")),
            Ok(Parsed::Help)
        );
    }
}
