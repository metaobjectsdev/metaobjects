//! The `render-helper` generator against the shared corpus
//! (`fixtures/template-output-render-conformance/`, see its README).
//!
//! Each sub-corpus is generated through the real run engine with the `entity` and
//! `render-helper` generators, against the corpus's own `templates/`, into a scratch Cargo
//! workspace. A probe crate (hand-written here) builds a payload from the generated value
//! objects, calls the generated helpers and prints what they return; the pins are the
//! README's. The workspace takes `metaobjects-render` from this checkout, since the generated
//! manifests ask crates.io for it.
//!
//! The drift cases need no build: generation itself must fail, with the code and the names
//! the README requires.

mod common;

use std::path::{Path, PathBuf};

use common::{Scratch, assert_builds, assert_formatted, copy_tree, generated_workspace, run_probe};
use metaobjects_codegen::engine::{RunOptions, run};
use metaobjects_codegen::{EntityGenerator, Generator, RenderHelperGenerator};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/template-output-render-conformance")
}

/// A project holding the corpus files `metas` (as `metaobjects/<name>`) and `templates` (as
/// `templates/`).
fn project(tag: &str, metas: &[&str], templates: &Path) -> Scratch {
    let s = Scratch::project(tag, &[]);
    for m in metas {
        let name = Path::new(m).file_name().unwrap().to_str().unwrap();
        let text = std::fs::read_to_string(corpus().join(m)).unwrap();
        s.write(&format!("metaobjects/{name}"), &text);
    }
    copy_tree(templates, &s.path().join("templates"));
    s
}

fn generators() -> Vec<Box<dyn Generator>> {
    vec![Box::new(EntityGenerator), Box::new(RenderHelperGenerator)]
}

fn generate(project: &Scratch) -> Result<(), String> {
    let mut opts = RunOptions::new(project.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &generators())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Every probe workspace builds into the one shared target directory, and each names its
/// binary `probe`: two built at once would run each other's.
static BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Generate `project`, build it with `probe` and return what the probe printed.
fn render(tag: &str, project: &Scratch, dependencies: &str, main: &str) -> String {
    let _serial = BUILD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    generate(project).unwrap_or_else(|e| panic!("{tag}: gen failed: {e}"));
    let ws = generated_workspace(tag, project, Some((dependencies, main)));
    assert_formatted(&ws);
    assert_builds(&ws, tag);
    run_probe(&ws)
}

/// The probe's dependencies: the generated crates it names, by path, and `serde_json`.
fn deps(crates: &[&str]) -> String {
    let mut out: String = crates
        .iter()
        .map(|c| format!("{c} = {{ path = \"../out/{c}\" }}\n"))
        .collect();
    out.push_str("serde_json = \"1\"\n");
    out
}

/// A probe `main` that renders through providers over `roots` (absolute paths, one per
/// line of output), given the body of a function `run(root) -> Vec<String>`.
fn probe_main(uses: &str, body: &str, roots: &[PathBuf]) -> String {
    let roots: Vec<String> = roots
        .iter()
        .map(|r| format!("{:?}", r.to_str().unwrap()))
        .collect();
    format!(
        "{uses}\n\
         fn run(root: &str) -> Vec<String> {{\n{body}\n}}\n\
         fn main() {{\n\
             for root in [{}] {{\n\
                 for line in run(root) {{\n\
                     println!(\"{{line}}\");\n\
                 }}\n\
             }}\n\
         }}\n",
        roots.join(", ")
    )
}

#[test]
fn welcome_page_and_email_render_what_the_corpus_pins() {
    let templates = corpus().join("templates");
    let p = project("rh-welcome", &["meta.json"], &templates);
    let body = r#"
    use acme_ai_prompts::{FilesystemProvider, render_welcome_email, render_welcome_page};
    let provider = FilesystemProvider::new(root);
    let mut out = Vec::new();
    for name in ["Ada", "<b>A & Co</b>"] {
        let payload: acme_ai::Welcome = serde_json::from_value(serde_json::json!({ "name": name })).unwrap();
        out.push(format!("{:?}", render_welcome_page(&payload, &provider).unwrap()));
        let email = render_welcome_email(&payload, &provider).unwrap();
        out.push(format!("{:?} {:?} {:?}", email.subject, email.html_body, email.text_body));
    }
    out"#;
    let printed = render(
        "rh-welcome",
        &p,
        &deps(&["acme_ai", "acme_ai_prompts"]),
        &probe_main("", body, &[templates]),
    );
    assert_eq!(
        printed.lines().collect::<Vec<_>>(),
        vec![
            r#""Hello Ada""#,
            r#""Welcome Ada" "<p>Hi Ada</p>" Some("Hi Ada")"#,
            r#""Hello &lt;b&gt;A &amp; Co&lt;/b&gt;""#,
            r#""Welcome <b>A & Co</b>" "<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>" Some("Hi <b>A & Co</b>")"#,
        ]
    );
}

#[test]
fn a_nested_and_array_email_renders_with_its_partial() {
    let templates = corpus().join("templates");
    let p = project("rh-nested", &["nested/meta.json"], &templates);
    let body = r#"
    let provider = model_prompts::FilesystemProvider::new(root);
    let payload: model::Order = serde_json::from_value(serde_json::json!({
        "customer": { "name": "Ada" },
        "items": [ { "sku": "A1", "qty": 2 }, { "sku": "B2", "qty": 1 } ]
    })).unwrap();
    let email = model_prompts::render_order_email(&payload, &provider).unwrap();
    vec![email.subject, email.html_body, email.text_body.unwrap()]"#;
    let printed = render(
        "rh-nested",
        &p,
        &deps(&["model", "model_prompts"]),
        &probe_main("", body, &[templates]),
    );
    assert_eq!(
        printed.lines().collect::<Vec<_>>(),
        vec![
            "Order for Ada",
            "<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme",
            "Order for Ada: A1 x2; B2 x1;",
        ]
    );
}

#[test]
fn a_cross_package_short_name_collision_resolves_each_reference_exactly() {
    let templates = corpus().join("templates");
    for (tag, dir) in [
        ("rh-xpkg", "xpkg-collision"),
        ("rh-xpkg-json", "xpkg-collision-json"),
    ] {
        let metas: Vec<String> = ["meta.alpha.json", "meta.beta.json", "meta.app.json"]
            .iter()
            .map(|m| format!("{dir}/{m}"))
            .collect();
        let metas: Vec<&str> = metas.iter().map(String::as_str).collect();
        let p = project(tag, &metas, &templates);
        let body = r#"
    let provider = acme_app_prompts::FilesystemProvider::new(root);
    // The generated types, one `Note` per package: each reference binds its own.
    let alpha: acme_alpha::Note = serde_json::from_value(serde_json::json!({ "alphaText": "AA" })).unwrap();
    let beta: acme_beta::Note = serde_json::from_value(serde_json::json!({ "betaText": "BB" })).unwrap();
    let payload: acme_app::Digest = serde_json::from_value(serde_json::json!({
        "fromAlpha": serde_json::to_value(&alpha).unwrap(),
        "fromBeta": serde_json::to_value(&beta).unwrap(),
    })).unwrap();
    vec![acme_app_prompts::render_digest_doc(&payload, &provider).unwrap()]"#;
        let printed = render(
            tag,
            &p,
            &deps(&["acme_app", "acme_alpha", "acme_beta", "acme_app_prompts"]),
            &probe_main("", body, std::slice::from_ref(&templates)),
        );
        assert_eq!(printed.trim_end(), "Alpha=AA Beta=BB", "{dir}");
    }
}

#[test]
fn a_template_edited_after_generation_fails_the_render() {
    let dir = corpus().join("runtime-drift");
    let p = project(
        "rh-runtime",
        &["runtime-drift/meta.json"],
        &dir.join("templates"),
    );
    // The clean bodies the helpers were generated against: the corpus's shared templates
    // carry the email parts, the runtime-drift templates the clean page.
    copy_tree(
        &corpus().join("templates/emails"),
        &p.path().join("templates/emails"),
    );
    std::fs::write(
        p.path().join("templates/pages/welcome.mustache"),
        "Hello {{name}}",
    )
    .unwrap();
    let clean = p.path().join("templates");
    let body = r#"
    use acme_ai_prompts::{FilesystemProvider, render_welcome_email, render_welcome_page, render_welcome_prompt};
    let provider = FilesystemProvider::new(root);
    let payload: acme_ai::Welcome = serde_json::from_value(serde_json::json!({ "name": "Ada" })).unwrap();
    vec![
        shown(render_welcome_page(&payload, &provider)),
        shown(render_welcome_prompt(&payload, &provider)),
        shown(render_welcome_email(&payload, &provider).map(|e| e.subject)),
    ]"#;
    let uses = "fn shown<T: std::fmt::Debug>(r: Result<T, acme_ai_prompts::RenderError>) -> String {\n\
                match r { Ok(v) => format!(\"ok {v:?}\"), Err(e) => format!(\"err {e}\") }\n}\n";
    let roots = [
        clean,
        dir.join("templates"),
        dir.join("email-subject"),
        dir.join("email-html"),
        dir.join("email-text"),
    ];
    let printed = render(
        "rh-runtime",
        &p,
        &deps(&["acme_ai", "acme_ai_prompts"]),
        &probe_main(uses, body, &roots),
    );
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(lines.len(), 15, "{printed}");
    let drift = "ERR_VAR_NOT_ON_PAYLOAD (nmae)";
    // Clean: everything renders.
    assert_eq!(
        &lines[0..3],
        &[
            r#"ok "Hello Ada""#,
            r#"ok "Hello Ada""#,
            r#"ok "Welcome Ada""#
        ]
    );
    // The drifted page fails both the output and the prompt helper; the email has no parts
    // under that root at all.
    assert!(
        lines[3].contains(drift) && lines[4].contains(drift),
        "{printed}"
    );
    assert!(lines[5].starts_with("err "), "{printed}");
    // Each email root drifts exactly one part, and the helper fails for each.
    for root in 0..3 {
        let email = lines[6 + root * 3 + 2];
        assert!(email.contains(drift), "email root {root}: {printed}");
    }
}

#[test]
fn a_variable_not_on_the_payload_fails_generation() {
    let dir = corpus().join("drift");
    let p = project("rh-drift", &["drift/meta.json"], &dir.join("templates"));
    let e = generate(&p).expect_err("the drift gate must fail codegen");
    for needle in [
        "ERR_VAR_NOT_ON_PAYLOAD",
        "missing",
        "WelcomePage",
        "pages/bad",
    ] {
        assert!(e.contains(needle), "{needle} not in: {e}");
    }
}

#[test]
fn a_section_drift_inside_an_array_fails_generation() {
    let templates = corpus().join("templates");
    let p = project("rh-section-drift", &["nested/meta.json"], &templates);
    std::fs::write(
        p.path().join("templates/emails/order.txt.mustache"),
        "{{#items}}{{bogus}}{{/items}}",
    )
    .unwrap();
    let e = generate(&p).expect_err("the drift gate must walk the section context");
    assert!(
        e.contains("ERR_VAR_NOT_ON_PAYLOAD") && e.contains("bogus"),
        "{e}"
    );
}

#[test]
fn an_unchanged_project_rewrites_nothing() {
    let templates = corpus().join("templates");
    let p = project("rh-idempotent", &["meta.json"], &templates);
    generate(&p).unwrap();
    let helper = "generated/acme_ai_prompts/src/welcome_page.rs";
    let before = p.mtime(helper);
    std::thread::sleep(std::time::Duration::from_millis(20));
    // A template edit changes the skip key, so the run does the work again, and still
    // writes nothing whose bytes did not change.
    std::fs::write(p.path().join("templates/README"), "x").unwrap();
    generate(&p).unwrap();
    assert_eq!(p.mtime(helper), before);
}
