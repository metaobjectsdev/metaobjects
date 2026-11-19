//! Runs every case of every official encode fixture through the encoder.

mod support {
    pub mod json;
}

use std::fs;
use std::path::PathBuf;
use toon_encode::{encode_with, Delimiter, Options, Value};

const EXPECTED_CASES: usize = 179;

fn get<'a>(obj: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn options(case: &[(String, Value)]) -> Options {
    let mut o = Options::default();
    if let Some(Value::Object(opts)) = get(case, "options") {
        for (k, v) in opts {
            match (k.as_str(), v) {
                ("delimiter", Value::Str(d)) => {
                    o.delimiter = match d.as_str() {
                        "," => Delimiter::Comma,
                        "\t" => Delimiter::Tab,
                        "|" => Delimiter::Pipe,
                        other => panic!("unknown delimiter {other:?}"),
                    }
                }
                ("indentSize", Value::Int(n)) => o.indent = *n as usize,
                _ => panic!("fixture option {k:?} is not applied by this suite"),
            }
        }
    }
    o
}

#[test]
fn official_encode_fixtures() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/encode");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .expect("fixture dir")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    assert_eq!(files.len(), 9, "expected 9 fixture files");

    let (mut total, mut failures) = (0usize, Vec::new());
    for path in &files {
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        let doc = support::json::parse(&fs::read_to_string(path).unwrap())
            .unwrap_or_else(|e| panic!("{fname}: {e}"));
        let Value::Object(doc) = doc else {
            panic!("{fname}: not an object")
        };
        let Some(Value::Array(tests)) = get(&doc, "tests") else {
            panic!("{fname}: no tests array")
        };
        for case in tests {
            let Value::Object(case) = case else {
                panic!("{fname}: bad case")
            };
            let name = match get(case, "name") {
                Some(Value::Str(n)) => n.clone(),
                _ => panic!("{fname}: case without name"),
            };
            assert!(
                !matches!(get(case, "shouldError"), Some(Value::Bool(true))),
                "{fname}/{name}: error cases are not supported"
            );
            let input = get(case, "input").expect("input");
            let Some(Value::Str(expected)) = get(case, "expected") else {
                panic!("{fname}/{name}: no expected string")
            };
            total += 1;
            let got = encode_with(input, &options(case));
            if &got != expected {
                failures.push(format!(
                    "{fname}/{name}: expected {expected:?}, got {got:?}"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failing:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(total, EXPECTED_CASES, "case count changed");
}
