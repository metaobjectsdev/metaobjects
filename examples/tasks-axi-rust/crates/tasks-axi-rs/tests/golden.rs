//! Golden outputs recorded from the real tasks-axi 0.2.6 (see `harness/golden.ts`): run
//! `tasks-axi-rs` over each recorded invocation and require the same stdout bytes, the same exit
//! code and an empty stderr. Needs no node.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Default)]
struct Case {
    name: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    files: Vec<(String, String)>,
    home: Vec<(String, String)>,
    code: i32,
    stdout: String,
}

fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn parse(text: &str) -> Vec<Case> {
    let mut cases = Vec::new();
    let mut cur: Option<Case> = None;
    for line in text.split('\n') {
        if line.is_empty() {
            if let Some(c) = cur.take() {
                cases.push(c);
            }
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let key = parts.next().unwrap_or("");
        let a = parts.next().unwrap_or("");
        let b = parts.next().unwrap_or("");
        if key == "case" {
            cur = Some(Case {
                name: a.to_string(),
                ..Case::default()
            });
            continue;
        }
        let c = cur.as_mut().expect("a record starts with `case`");
        match key {
            "arg" => c.args.push(unescape(a)),
            "env" => c.env.push((a.to_string(), unescape(b))),
            "file" => c.files.push((unescape(a), b.to_string())),
            "home" => c.home.push((unescape(a), b.to_string())),
            "code" => c.code = a.parse().expect("exit code"),
            "stdout" => c.stdout = unescape(a),
            other => panic!("unknown golden key {other}"),
        }
    }
    cases
}

fn write_tree(root: &Path, files: &[(String, String)], fixtures: &Path) {
    for (rel, fixture) in files {
        let dest = root.join(rel);
        fs::create_dir_all(dest.parent().expect("parent")).expect("mkdir");
        fs::copy(fixtures.join(fixture), dest).expect("copy fixture");
    }
}

fn scratch() -> PathBuf {
    let base = std::env::var_os("DEV_SCRATCH")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("tasks-axi-rs-golden-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("scratch");
    dir
}

#[test]
fn matches_the_recorded_outputs() {
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let fixtures = golden.join("fixtures");
    let cases = parse(&fs::read_to_string(golden.join("golden.txt")).expect("golden.txt"));
    assert!(cases.len() > 100, "only {} golden cases", cases.len());

    let root = scratch();
    let mut failures: Vec<String> = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let dir = root.join(format!("c{i}"));
        let (cwd, home) = (dir.join("cwd"), dir.join("home"));
        fs::create_dir_all(&cwd).expect("cwd");
        fs::create_dir_all(&home).expect("home");
        write_tree(&cwd, &case.files, &fixtures);
        write_tree(&home, &case.home, &fixtures);
        let out = Command::new(env!("CARGO_BIN_EXE_tasks-axi-rs"))
            .args(&case.args)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", &home)
            .env("TZ", "UTC")
            .envs(case.env.iter().map(|(k, v)| (k, v)))
            .output()
            .expect("run tasks-axi-rs");
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if stdout != case.stdout || out.status.code() != Some(case.code) || !out.stderr.is_empty() {
            failures.push(format!(
                "{}: args {:?}\n  code want {} got {:?}\n  want {:?}\n  got  {:?}\n  stderr {:?}",
                case.name,
                case.args,
                case.code,
                out.status.code(),
                case.stdout,
                stdout,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    let _ = fs::remove_dir_all(&root);
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
