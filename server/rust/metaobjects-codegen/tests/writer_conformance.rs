//! The shared code-writer corpus (`fixtures/writer-conformance/`, ADR-0063), dialects `core`
//! and `rust`.
//!
//! Every port's writer runs the `core` cases; the `rust` cases pin this port's dialect (the
//! rustfmt rules for `use` lists, doc comments and assignments). A case of another dialect
//! (`typescript`, `python`, ...) belongs to that port's writer and is skipped here by name.

use std::path::PathBuf;

use metaobjects_codegen::writer::{CodeWriter, List, Piece, WriterOptions};
use serde_json::Value;

const DIALECT_CORE: &str = "core";
const DIALECT_RUST: &str = "rust";

fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/writer-conformance/cases")
}

fn piece(v: &Value) -> Piece {
    match v {
        Value::String(s) => Piece::Text(s.clone()),
        Value::Array(parts) => Piece::Seq(parts.iter().map(piece).collect()),
        Value::Object(o) => {
            let l = o
                .get("list")
                .and_then(Value::as_object)
                .expect("a part object is {\"list\": {...}}");
            Piece::List(List {
                open: l["open"].as_str().expect("list.open").to_string(),
                items: l["items"]
                    .as_array()
                    .expect("list.items")
                    .iter()
                    .map(piece)
                    .collect(),
                close: l["close"].as_str().expect("list.close").to_string(),
                pad: l.get("pad").and_then(Value::as_bool).unwrap_or(false),
            })
        }
        other => panic!("unknown part {other}"),
    }
}

fn parts(args: &[Value]) -> Piece {
    Piece::Seq(args.iter().map(piece).collect())
}

fn run_case(case: &Value) -> Result<String, metaobjects_codegen::writer::WriterError> {
    // A `core` case states every option; a dialect case takes the dialect's defaults.
    let mut w = match case.get("options") {
        Some(o) => CodeWriter::with_options(WriterOptions {
            indent: o["indent"].as_str().expect("options.indent").to_string(),
            width: usize::try_from(o["width"].as_u64().expect("options.width")).unwrap(),
            trailing_comma: o["trailingComma"].as_bool().expect("options.trailingComma"),
        }),
        None => CodeWriter::new(),
    };
    let text = |v: &Value| v.as_str().expect("a text argument").to_string();
    for op in case["ops"].as_array().expect("ops") {
        let op = op.as_array().expect("an op is an array");
        let name = op[0].as_str().expect("op name");
        let args = &op[1..];
        match name {
            "line" => {
                w.line(parts(args));
            }
            "open" => {
                w.open(parts(args));
            }
            "close" => {
                w.close(parts(args));
            }
            "blank" => {
                w.blank();
            }
            "text" => {
                w.text(args[0].as_str().expect("text snippet"));
            }
            "use" => {
                let names: Vec<String> = args[1..].iter().map(text).collect();
                let names: Vec<&str> = names.iter().map(String::as_str).collect();
                w.use_list(&text(&args[0]), &names);
            }
            "doc" => {
                w.doc(&text(&args[0]));
            }
            "prose" => {
                w.prose(&text(&args[0]));
            }
            "docBreak" => {
                w.doc_break();
            }
            "assign" => {
                w.assign(&text(&args[0]), parts(&args[1..]));
            }
            other => panic!("unknown op {other}"),
        }
    }
    w.finish()
}

#[test]
fn every_core_case_passes() {
    run_dialect(DIALECT_CORE);
}

#[test]
fn every_rust_case_passes() {
    run_dialect(DIALECT_RUST);
}

fn run_dialect(dialect: &str) {
    let mut names: Vec<PathBuf> = std::fs::read_dir(cases_dir())
        .expect("the writer-conformance cases directory")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    names.sort();
    let mut ran = 0;
    let mut failures = Vec::new();
    for path in names {
        let case: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).expect("case JSON");
        if case["dialect"].as_str() != Some(dialect) {
            continue;
        }
        ran += 1;
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let got = run_case(&case);
        if let Some(code) = case.get("error").and_then(Value::as_str) {
            match got {
                Ok(text) => failures.push(format!("{name}: expected {code}, wrote {text:?}")),
                Err(e) => {
                    if e.code != code {
                        failures.push(format!("{name}: expected {code}, got {}", e.code));
                    }
                    if let Some(q) = case.get("errorQuotes").and_then(Value::as_str)
                        && !e.message.contains(q)
                    {
                        failures.push(format!("{name}: message {:?} lacks {q:?}", e.message));
                    }
                }
            }
            continue;
        }
        let lines: Vec<&str> = case["expected"]
            .as_array()
            .expect("expected lines")
            .iter()
            .map(|l| l.as_str().expect("an expected line"))
            .collect();
        let want = if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        };
        match got {
            Ok(text) if text == want => {}
            Ok(text) => failures.push(format!("{name}:\n--- want\n{want}--- got\n{text}")),
            Err(e) => failures.push(format!("{name}: unexpected {e}")),
        }
    }
    assert!(ran > 0, "no {dialect} case found");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
