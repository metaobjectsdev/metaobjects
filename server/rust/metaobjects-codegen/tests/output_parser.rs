//! The `output-parser` and `output-prompt` generators, end to end: a model with a JSON and
//! an XML responding prompt is generated with `entity`, the generated crates are built, and a
//! probe reads replies through them and renders their fragments.
//!
//! The oracles: the descriptors the generated code builds must be the ones the engine
//! derives from the model (`inbound`, the derivation the runtime extract of every port
//! makes), field for field; the extract of a dirty reply must read what the extract corpus
//! says such a reply reads as; and the generated fragment must be the render crate's fragment
//! of that descriptor, byte for byte.

mod common;

use std::path::PathBuf;

use common::{Scratch, assert_builds, assert_formatted, generated_workspace, run_probe};
use metaobjects::validate::util::ObjectIndex;
use metaobjects_codegen::engine::{RunOptions, run};
use metaobjects_codegen::inbound::{
    extract_schema, inbound_templates, output_format_spec, prompt_style, reply_format,
    response_object,
};
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::render::prompt::{
    OutputFormatSpec, PromptOverrides, render_output_format,
};
use metaobjects_codegen::{
    EntityGenerator, Generator, OutputParserGenerator, OutputPromptGenerator,
};

const MODEL: &str = r#"{ "metadata.root": { "package": "acme::ai", "children": [
  { "object.value": { "name": "Question", "children": [
    { "field.string": { "name": "text" } }
  ] } },
  { "object.value": { "name": "Reviewer", "children": [
    { "field.string": { "name": "name", "@required": true } }
  ] } },
  { "object.value": { "name": "Verdict", "children": [
    { "field.enum": { "name": "label", "@required": true, "@values": ["YES", "NO", "UNSURE"],
      "@enumAlias": { "yep": "YES" }, "@coerceDefault": "UNSURE",
      "@enumDoc": { "YES": "Supported.", "NO": "Contradicted.", "UNSURE": "Not enough to go on." } } },
    { "field.int": { "name": "score", "children": [
      { "validator.numeric": { "@min": 0, "@max": 10 } }
    ] } },
    { "field.string": { "name": "tags", "isArray": true, "children": [
      { "validator.array": { "@max": 3 } }
    ] } },
    { "field.object": { "name": "reviewer", "@objectRef": "Reviewer" } },
    { "field.string": { "name": "note", "@example": "short", "@instruction": "one line" } }
  ] } },
  { "template.prompt": { "name": "Judge", "@payloadRef": "Question", "@textRef": "prompts/judge",
    "@responseRef": "Verdict" } },
  { "template.prompt": { "name": "JudgeXml", "@payloadRef": "Question", "@textRef": "prompts/judge",
    "@responseRef": "Verdict", "@responseFormat": "xml", "@promptStyle": "inline" } }
] } }"#;

fn generators() -> Vec<Box<dyn Generator>> {
    vec![
        Box::new(EntityGenerator),
        Box::new(OutputParserGenerator),
        Box::new(OutputPromptGenerator),
    ]
}

const SHOW: &str = r#"fn show(spec: &OutputFormatSpec) -> String {
    let mut spec = spec.clone();
    let mut docs = Vec::new();
    for f in &mut spec.fields {
        let doc: std::collections::BTreeMap<_, _> = f.enum_doc.take().unwrap_or_default().into_iter().collect();
        docs.push(doc);
    }
    format!("{spec:?} {docs:?}")
}"#;

/// A descriptor's Debug text with each `enum_doc` map in member order: a `HashMap` prints in
/// no fixed order.
fn show(spec: &OutputFormatSpec) -> String {
    let mut spec = spec.clone();
    let mut docs = Vec::new();
    for f in &mut spec.fields {
        let doc: std::collections::BTreeMap<_, _> =
            f.enum_doc.take().unwrap_or_default().into_iter().collect();
        docs.push(doc);
    }
    format!("{spec:?} {docs:?}")
}

/// What the engine derives for each responding prompt, as the probe prints it.
fn derived(p: &Scratch) -> Vec<String> {
    let loaded = load_project(p.path(), None, true).unwrap_or_else(|e| panic!("{e:?}"));
    let (tree, root) = (&loaded.result.tree, loaded.result.root);
    let index = ObjectIndex::build(tree, root);
    let mut out = Vec::new();
    for t in inbound_templates(tree, root) {
        let response = response_object(tree, &index, t).unwrap();
        let format = reply_format(tree, t);
        out.push(format!(
            "{:?}",
            extract_schema(tree, &index, response, format)
        ));
        let spec = output_format_spec(tree, response, format, prompt_style(tree, t));
        out.push(show(&spec));
        out.push(format!(
            "{:?}",
            render_output_format(&spec, &PromptOverrides::default())
        ));
    }
    out
}

const PROBE: &str = r##"
use metaobjects_render::prompt::OutputFormatSpec;

SHOW

use acme_ai_formats::{
    PromptOverrides, judge_format_spec, judge_xml_format_spec, render_judge_format,
    render_judge_xml_format,
};
use acme_ai_parsers::{
    ExtractOptions, extract_judge, extract_judge_xml, judge_schema, judge_xml_schema, parse_judge,
};

fn main() {
    let none = PromptOverrides::default();
    // The descriptors and fragments, in the order the test derives them.
    println!("{:?}", judge_schema());
    println!("{}", show(&judge_format_spec()));
    println!("{:?}", render_judge_format(&none));
    println!("{:?}", judge_xml_schema());
    println!("{}", show(&judge_xml_format_spec()));
    println!("{:?}", render_judge_xml_format(&none));

    // Strict: exact JSON reads; anything else is an error.
    let exact = r#"{"label":"NO","score":4,"tags":["a"],"reviewer":{"name":"Ada"},"note":"n"}"#;
    let v = parse_judge(exact).unwrap();
    println!("strict {:?} {:?} {}", v.label, v.score, v.reviewer.unwrap().name);
    println!("strict-prose {}", parse_judge(&format!("Here: {exact}")).is_err());

    // Tolerant: a fenced reply with a synonym, a trailing comma and an out-of-range score.
    let opts = ExtractOptions::default();
    let dirty = "Sure!\n```json\n{\"label\": \"yep\", \"score\": 42, \"reviewer\": {\"name\": \"Ada\"},}\n```";
    let got = extract_judge(dirty, &opts);
    let v = got.value.expect("a complete answer");
    println!("tolerant {:?} {:?} {}", v.label, v.score, v.reviewer.unwrap().name);
    let states = got.outcome.report.states();
    println!("states label={} tags={}", states["label"], states["tags"]);

    // A reply that loses the required label keeps its report and no value.
    let got = extract_judge("{\"score\": 3}", &opts);
    println!("lost {} {}", got.value.is_none(), got.outcome.report.states()["label"]);

    // XML: no strict parse; the tolerant read takes the root the fragment teaches.
    let got = extract_judge_xml("<Verdict><label>no</label><score>2</score></Verdict>", &opts);
    let v = got.value.expect("a complete answer");
    println!("xml {:?} {:?}", v.label, v.score);
}
"##;

#[test]
fn the_generated_parsers_and_fragments_read_and_teach_the_declared_shape() {
    let p = Scratch::project("op-judge", &[]);
    p.write("metaobjects/meta.ai.json", MODEL);
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &generators()).unwrap_or_else(|e| panic!("gen failed: {e}"));

    let deps = "acme_ai = { path = \"../out/acme_ai\" }\n\
                acme_ai_parsers = { path = \"../out/acme_ai_parsers\" }\n\
                acme_ai_formats = { path = \"../out/acme_ai_formats\" }\n";
    let probe = PROBE.replace("SHOW", SHOW);
    let deps = format!(
        "{deps}metaobjects-render = \"{}\"\n",
        metaobjects_codegen::render::REQUIREMENT
    );
    let ws = generated_workspace("op-judge", &p, Some((&deps, &probe)));
    assert_formatted(&ws);
    assert_builds(&ws, "op-judge");
    let printed = run_probe(&ws);
    let lines: Vec<&str> = printed.lines().collect();

    // The generated descriptors and fragments are the derived ones (Judge, then JudgeXml).
    assert_eq!(&lines[..6], derived(&p).as_slice());
    assert!(
        !p.read("generated/acme_ai_parsers/src/judge_xml.rs")
            .contains("pub fn parse_")
    );

    // The reads, pinned from the extract corpus's rules: an alias folds to its member, a
    // number past the validator's range clamps to it, an absent optional array is lost.
    assert_eq!(
        &lines[6..],
        &[
            "strict No Some(4) Ada",
            "strict-prose true",
            "tolerant Yes Some(10) Ada",
            "states label=EXTRACTED tags=LOST_OPTIONAL",
            "lost true LOST_REQUIRED",
            "xml No Some(2)",
        ]
    );
}

#[test]
fn a_model_with_no_responding_prompt_gets_no_parser_or_fragment_crate() {
    let p = Scratch::project("op-none", &[]);
    p.write(
        "metaobjects/meta.ai.json",
        r#"{ "metadata.root": { "package": "acme::ai", "children": [
  { "object.value": { "name": "Question", "children": [ { "field.string": { "name": "text" } } ] } },
  { "template.prompt": { "name": "Ask", "@payloadRef": "Question", "@textRef": "prompts/ask" } }
] } }"#,
    );
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &generators()).unwrap();
    assert!(p.exists("generated/acme_ai/Cargo.toml"));
    assert!(!p.exists("generated/acme_ai_parsers"));
    assert!(!p.exists("generated/acme_ai_formats"));
}
