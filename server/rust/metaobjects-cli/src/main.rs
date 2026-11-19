//! `cargo-meta`: the binary behind `cargo meta`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("cargo meta: cannot read the current directory: {e}");
            std::process::exit(1);
        }
    };
    let code = metaobjects_cli::main_with(
        &args,
        &cwd,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    );
    std::process::exit(code);
}
