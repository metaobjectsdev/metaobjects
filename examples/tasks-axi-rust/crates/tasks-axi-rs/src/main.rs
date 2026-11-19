//! tasks-axi-rs: the read path of tasks-axi (show, list, ready), parsed, dispatched and printed
//! by code generated from the MetaObjects model, over a hand-written markdown backlog reader.

mod app;
mod config;
mod derive;
mod grammar;
mod jsutil;
mod suggest;
mod view;

use std::io::Write;
use tasks_axi_gen::dispatch::{run, Outcome};

fn main() {
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let mut app = app::App::new(config::Env::from_process());
    let (text, code) = match run(&argv, &mut app) {
        Outcome::Output(s) => (format!("{s}\n"), 0),
        Outcome::Verbatim(s) => (s, 0),
        Outcome::Failure(e) => (format!("{}\n", view::render_error(&e)), e.exit_code()),
    };
    // A closed pipe is not an error here, as in the Node tool.
    let _ = std::io::stdout().write_all(text.as_bytes());
    std::process::exit(code);
}
