//! Generator options (ADR-0063 item 7, the plan's W-RS-1): an entry of
//! `metaobjects.config.json` may carry options, they reach the generator through its
//! constructor ([`Generator::configure`]), and an option a generator does not take fails the
//! run by name instead of being ignored.

mod common;

use std::path::PathBuf;

use common::{Scratch, shop_files};
use metaobjects_codegen::generator::{ERR_UNKNOWN_OPTION, Options, unknown_options};
use metaobjects_codegen::{
    EmittedFile, GenContext, GenError, Generator, RunError, RunOptions, run, shipped_generators,
};

/// Writes one file whose text is its `greeting` option, `hello` when the project sets none.
struct Greeter {
    greeting: String,
}

impl Generator for Greeter {
    fn name(&self) -> &str {
        "greeter"
    }
    fn identity(&self) -> String {
        format!("greeter:1:{}", self.greeting)
    }
    fn configure(&self, options: &Options) -> Result<Box<dyn Generator>, GenError> {
        const KNOWN: &[&str] = &["greeting"];
        if options.keys().any(|k| !KNOWN.contains(&k.as_str())) {
            return Err(unknown_options(self.name(), options, KNOWN));
        }
        let greeting = options
            .get("greeting")
            .and_then(|v| v.as_str())
            .ok_or_else(|| GenError::new(ERR_UNKNOWN_OPTION, "greeting must be a string"))?;
        Ok(Box::new(Greeter {
            greeting: greeting.to_string(),
        }))
    }
    fn generate(&self, _: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        Ok(vec![EmittedFile::new(
            "greeting.txt",
            self.greeting.clone(),
        )])
    }
}

fn greeter() -> Vec<Box<dyn Generator>> {
    vec![Box::new(Greeter {
        greeting: "hello".to_string(),
    })]
}

fn gen_into(p: &Scratch, generators: &[Box<dyn Generator>]) -> Result<(), RunError> {
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, generators).map(|_| ())
}

#[test]
fn an_entry_options_construct_the_generator_and_a_change_regenerates() {
    let p = Scratch::project("options-construct", &shop_files());
    gen_into(&p, &greeter()).unwrap();
    assert_eq!(
        p.read("generated/greeting.txt"),
        "hello",
        "no list: the generator as offered"
    );

    p.write(
        "metaobjects.config.json",
        r#"{ "generators": [{ "name": "greeter", "options": { "greeting": "ahoy" } }] }"#,
    );
    gen_into(&p, &greeter()).unwrap();
    assert_eq!(
        p.read("generated/greeting.txt"),
        "ahoy",
        "the configured generator ran"
    );

    // An entry with no options, or empty ones, runs the generator as offered.
    p.write(
        "metaobjects.config.json",
        r#"{ "generators": [{ "name": "greeter", "options": {} }] }"#,
    );
    gen_into(&p, &greeter()).unwrap();
    assert_eq!(p.read("generated/greeting.txt"), "hello");
}

#[test]
fn an_option_a_generator_does_not_take_fails_the_run_by_name_and_writes_nothing() {
    let p = Scratch::project("options-unknown", &shop_files());
    p.write(
        "metaobjects.config.json",
        r#"{ "generators": [{ "name": "greeter", "options": { "greting": "ahoy" } }] }"#,
    );
    let e = gen_into(&p, &greeter()).unwrap_err().to_string();
    assert!(e.contains(ERR_UNKNOWN_OPTION), "{e}");
    assert!(
        e.contains("the generator greeter has no option \"greting\"; it takes: greeting"),
        "{e}"
    );
    assert!(!p.exists("generated"), "nothing written");
}

#[test]
fn a_shipped_generator_takes_no_options_yet_and_refuses_any() {
    let p = Scratch::project("options-shipped", &shop_files());
    p.write(
        "metaobjects.config.json",
        r#"{ "generators": ["entity", { "name": "client", "options": { "pageSize": 25 } }] }"#,
    );
    let e = gen_into(&p, &shipped_generators()).unwrap_err().to_string();
    assert!(
        e.contains("the generator client has no option \"pageSize\"; it takes no options"),
        "{e}"
    );
    assert!(!p.exists("generated"), "nothing written");
}

#[test]
fn a_narrowed_run_still_refuses_a_listed_entry_bad_option() {
    let p = Scratch::project("options-narrowed", &shop_files());
    p.write(
        "metaobjects.config.json",
        r#"{ "generators": ["entity", { "name": "client", "options": { "x": 1 } }] }"#,
    );
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    opts.generators = Some(vec!["entity".to_string()]);
    let e = run(&opts, &shipped_generators()).unwrap_err().to_string();
    assert!(
        e.contains("the generator client has no option \"x\""),
        "{e}"
    );
}
