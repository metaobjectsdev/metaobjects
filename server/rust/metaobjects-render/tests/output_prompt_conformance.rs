//! The shared output-format fragment corpus (`fixtures/output-prompt-conformance/`): each
//! `spec.json` renders byte-exact in all three styles, and a `roundTrip` case's example
//! reads back through the reply parser with no field malformed or lost.

use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects_render::extract::{
    ExtractOptions, ExtractSchema, FieldExtraction, FieldKind, FieldSpec, Format, extract,
};
use metaobjects_render::prompt::{
    OutputFormatSpec, PromptField, PromptOverrides, PromptStyle, render_output_format,
};

/// The corpus size: a deleted case fails here.
const CASES: usize = 17;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/output-prompt-conformance")
}

fn format_of(c: &Value) -> Format {
    match c["format"].as_str() {
        Some("json") => Format::Json,
        Some("xml") => Format::Xml,
        other => panic!("unknown format {other:?}"),
    }
}

fn kind_of(f: &Value) -> FieldKind {
    FieldKind::parse(f["kind"].as_str().expect("kind")).expect("known kind")
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| {
        a.iter()
            .map(|x| x.as_str().expect("string").to_string())
            .collect()
    })
}

fn output_spec(c: &Value) -> OutputFormatSpec {
    let fields = c["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .map(|f| PromptField {
            array: f["array"].as_bool().unwrap_or(false),
            enum_values: strings(&f["enumValues"]),
            enum_doc: f["enumDoc"].as_object().map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().expect("doc").to_string()))
                    .collect()
            }),
            example: f["example"].as_str().map(str::to_string),
            instruction: f["instruction"].as_str().map(str::to_string),
            nested: f["nested"]
                .is_object()
                .then(|| Box::new(output_spec(&f["nested"]))),
            ..PromptField::new(
                f["name"].as_str().expect("name"),
                kind_of(f),
                f["required"].as_bool().expect("required"),
            )
        })
        .collect();
    OutputFormatSpec {
        format: format_of(c),
        root_name: c["rootName"].as_str().expect("rootName").to_string(),
        style: PromptStyle::Guide,
        fields,
    }
}

fn extract_schema(c: &Value) -> ExtractSchema {
    let fields = c["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .map(|f| {
            let name = f["name"].as_str().expect("name");
            let required = f["required"].as_bool().expect("required");
            match kind_of(f) {
                FieldKind::Enum => FieldSpec::enumeration(
                    name,
                    required,
                    strings(&f["enumValues"]).unwrap_or_default(),
                ),
                FieldKind::Object => {
                    let spec = FieldSpec::object(name, required, extract_schema(&f["nested"]));
                    if f["array"].as_bool().unwrap_or(false) {
                        spec.array()
                    } else {
                        spec
                    }
                }
                kind => FieldSpec::scalar(name, kind, required),
            }
        })
        .collect();
    ExtractSchema {
        format: format_of(c),
        root_name: c["rootName"].as_str().expect("rootName").to_string(),
        fields,
    }
}

fn run_case(dir: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(dir.join("spec.json")).map_err(|e| e.to_string())?;
    let c: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let spec = output_spec(&c);
    let mut problems = Vec::new();
    for (key, style) in [
        ("guide", PromptStyle::Guide),
        ("inline", PromptStyle::Inline),
        ("exampleOnly", PromptStyle::ExampleOnly),
    ] {
        let overrides = PromptOverrides {
            style: Some(style),
            ..PromptOverrides::default()
        };
        let actual = render_output_format(&spec, &overrides);
        let expected = std::fs::read_to_string(dir.join(format!("expected.{key}.txt")))
            .map_err(|e| e.to_string())?;
        if actual != expected {
            problems.push(format!(
                "{key}:\n    want {expected:?}\n    got  {actual:?}"
            ));
        }
    }
    if c["roundTrip"].as_bool().unwrap_or(false) {
        let example = std::fs::read_to_string(dir.join("expected.exampleOnly.txt"))
            .map_err(|e| e.to_string())?;
        let outcome = extract(
            Some(&example),
            &extract_schema(&c),
            &ExtractOptions::default(),
        );
        for (path, state) in outcome.report.states() {
            if matches!(
                state,
                FieldExtraction::Malformed
                    | FieldExtraction::LostRequired
                    | FieldExtraction::LostOptional
            ) {
                problems.push(format!("round trip: {path} is {state}"));
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n  "))
    }
}

#[test]
fn output_prompt_conformance_corpus() {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .expect("fixtures/output-prompt-conformance")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("spec.json").is_file())
        .collect();
    dirs.sort();
    assert_eq!(dirs.len(), CASES, "output-prompt-conformance case count");
    let failures: Vec<String> = dirs
        .iter()
        .filter_map(|d| {
            run_case(d)
                .err()
                .map(|e| format!("FAIL {}:\n  {e}", d.file_name().unwrap().to_string_lossy()))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
