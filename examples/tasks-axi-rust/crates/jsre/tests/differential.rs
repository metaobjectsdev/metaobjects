//! Differential test: every real pattern is run over deterministic pseudo-random
//! inputs through both `jsre` and node's `RegExp` (via `tests/oracle.mjs`).

use jsre::Regex;
use std::path::PathBuf;
use std::process::Command;

const CASES_PER_PATTERN: usize = 4000;

// ---- tiny JSON writer / reader ------------------------------------------------

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (' '..='~').contains(&c) => o.push(c),
            c => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{:04x}", u));
                }
            }
        }
    }
    o.push('"');
    o
}

#[derive(Debug, Clone, PartialEq)]
enum J {
    Null,
    Num(usize),
    Arr(Vec<J>),
}

fn parse_json(s: &[u8], p: &mut usize) -> J {
    match s[*p] {
        b'n' => {
            *p += 4;
            J::Null
        }
        b'[' => {
            *p += 1;
            let mut v = Vec::new();
            while s[*p] != b']' {
                v.push(parse_json(s, p));
                if s[*p] == b',' {
                    *p += 1;
                }
            }
            *p += 1;
            J::Arr(v)
        }
        _ => {
            let st = *p;
            while s[*p].is_ascii_digit() {
                *p += 1;
            }
            J::Num(std::str::from_utf8(&s[st..*p]).unwrap().parse().unwrap())
        }
    }
}

type Groups = Vec<Option<(usize, usize)>>;

fn to_matches(j: &J) -> Vec<Groups> {
    let J::Arr(ms) = j else {
        panic!("bad oracle output")
    };
    ms.iter()
        .map(|m| {
            let J::Arr(gs) = m else { panic!("bad match") };
            gs.iter()
                .map(|g| match g {
                    J::Null => None,
                    J::Arr(p) => match (&p[0], &p[1]) {
                        (J::Num(a), J::Num(b)) => Some((*a, *b)),
                        _ => panic!("bad pair"),
                    },
                    _ => panic!("bad group"),
                })
                .collect()
        })
        .collect()
}

// ---- deterministic RNG ----------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, v: &[&'a str]) -> &'a str {
        v[self.below(v.len())]
    }
}

const VOCAB: &[&str] = &[
    "fix-login-k3",
    "a",
    "Z9",
    "x.y_z-1",
    "-bad",
    ".dot",
    "foo bar",
    "SHIP",
    "SCOUT",
    "DOCS-ONLY",
    "PERSISTENT SECONDMATE",
    "SHIPPING",
    "SCOUTx",
    "SHIP-it",
    " ",
    "  ",
    "\t",
    "\u{a0}",
    "\u{3000}",
    "\u{2003}",
    "\u{feff}",
    "\u{b}",
    "\u{c}",
    "\u{2028}",
    "\u{200b}",
    "\u{85}",
    "\r",
    "\n",
    " - ",
    "-",
    "blocked-by:",
    "parent:",
    "discovered-from:",
    " blocked-by: ",
    "blocked-by:x",
    "parent: ",
    "(repo: x)",
    "(repo: a/b)",
    "(a + repo: c)",
    "(repo:)",
    "(kind: y)",
    "(kind: ship)",
    "(priority: 3)",
    "(priority: 9)",
    "(priority:0)",
    "(since 2026-01-02)",
    "(since 2026-1-02)",
    "(merged 2026-01-02)",
    "(reported 2026-06-22)",
    "(done 2026-01-02)",
    "(closed 2026-01-02)",
    "(hold: a b)",
    "(hold: x (y))",
    "(hold-kind: external)",
    "(hold-kind: captain)",
    "(hold-kind: parked)",
    "(hold-kind: future)",
    "(hold-kind: load)",
    "(hold-kind: bogus)",
    "(hold-until: 2026-12-31)",
    "(hold-until: 2026-12-3)",
    " - reason text",
    " - ",
    "reason",
    "https://github.com/o/r/pull/12",
    "http://example.com/x",
    "https://example.com/a/b/pulls/7",
    "data/x/report.md",
    "data/a/b/report.md",
    "data/report.md",
    "report.md",
    "data/x/report.mdx",
    "xdata/x/report.md",
    "(",
    ")",
    "((",
    "))",
    "()",
    "[",
    "]",
    "*",
    "**",
    "- [ ] ",
    "- [x] ",
    "- **",
    "- [X] ",
    "## ",
    "##",
    "### ",
    "Heading",
    "<!-- tasks-axi:public-followup/v1:",
    "<!-- tasks-axi:public-followup/v12:ab_C-9",
    " -->",
    "é",
    "ß",
    "日本",
    "😀",
    "a😀b",
    ".",
    ",",
    ";",
    "text",
    "2026-01-02",
    "0",
    "1",
    "42",
    "/",
    ":",
    "?",
    "#",
    "@",
    "_",
    "\\",
];

const NOISE: &[char] = &[
    ' ', '(', ')', '-', ':', '*', '[', ']', 'a', 'b', 'x', 'Z', '0', '9', '.', '/', ',', ';', '!',
    '#', '_', '\t', '\u{a0}', 'é', '😀', '日', 'h', 't', 'p', 's', '=', '"', '\'', '\u{3000}',
];

type Skel = &'static [&'static [&'static str]];

const IDS: &[&str] = &["fix-login-k3", "a.b", "-x", "", "x y", "Z9_", "é"];
const REST: &[&str] = &[
    "rest text",
    "",
    "x\u{a0}y",
    "(repo: x)",
    "😀",
    "a\r",
    " ",
    "(kind: y) ",
];

/// Slot-wise skeletons (first alternative is canonical) for the anchored
/// patterns, whose random-fragment hit rate would otherwise be tiny.
fn skeleton(name: &str) -> Skel {
    match name {
        "IN_FLIGHT_RE" => &[
            &["- **", "- [ ] ", "- *"],
            IDS,
            &["** - ", "**  - ", "** -", "*** - "],
            REST,
        ],
        "QUEUED_RE" => &[
            &["- [ ] ", "- [x] ", "- [ ]"],
            IDS,
            &[" - ", "  - ", " -"],
            REST,
        ],
        "DONE_RE" => &[
            &["- [x] ", "- [X] ", "- [ ] "],
            IDS,
            &[" - ", "  - ", " -"],
            REST,
        ],
        "TAIL_HOLD_UNTIL" => &[
            &["text ", ""],
            &["(hold-until: ", "(hold-until:", "(hold-until:  "],
            &["2026-12-31", "2026-1-31"],
            &[")", ") ", ")\u{a0}", "))"],
        ],
        "TAIL_CLOSED" => &[
            &["text ", ""],
            &["(merged ", "(done ", "(reported ", "(since "],
            &["2026-01-02", "2026-1-02"],
            &[")", ") ", ")\u{3000}", "))"],
        ],
        "PUBLIC_FOLLOWUP_METADATA_RE" => &[
            &["<!-- tasks-axi:public-followup/v"],
            &["1", "12", "", "x"],
            &[":"],
            &["ab_C-9", "a b", ""],
            &[" -->", " --> ", ">"],
        ],
        "PR_URL_RE" => &[
            &["https://", "http://"],
            &["github.com", "example.org", "GitHub.com", "a-b.c", "-a.com"],
            &["/"],
            &["o", "o.p", "..", "a b"],
            &["/"],
            &["r", "r_s", "."],
            &["/"],
            &["pull", "pulls", "pull/"],
            &["/"],
            &["12", "0", "07", "1a"],
            &["", "/", "?x"],
        ],
        _ => &[],
    }
}

fn gen_skel(rng: &mut Rng, skel: Skel) -> String {
    let mut s = String::new();
    for slot in skel {
        if rng.below(100) < 75 {
            s.push_str(slot[0]);
        } else {
            s.push_str(rng.pick(slot));
        }
    }
    s
}

fn gen(rng: &mut Rng, focus: &[&str], skel: Skel) -> String {
    if !skel.is_empty() && rng.below(100) < 70 {
        return gen_skel(rng, skel);
    }
    if rng.below(10) == 0 {
        let n = rng.below(30);
        return (0..n).map(|_| NOISE[rng.below(NOISE.len())]).collect();
    }
    let mut s = String::new();
    for _ in 0..1 + rng.below(9) {
        if !focus.is_empty() && rng.below(100) < 55 {
            s.push_str(rng.pick(focus));
        } else {
            s.push_str(rng.pick(VOCAB));
        }
    }
    if rng.below(10) < 3 {
        let mut cs: Vec<char> = s.chars().collect();
        if !cs.is_empty() {
            let i = rng.below(cs.len());
            match rng.below(3) {
                0 => {
                    cs.remove(i);
                }
                1 => cs.insert(i, NOISE[rng.below(NOISE.len())]),
                _ => {
                    let c = cs[i];
                    cs.insert(i, c);
                }
            }
        }
        s = cs.into_iter().collect();
    }
    s
}

// ---- the real patterns (verbatim regex sources from the tasks-axi package) ------

const ID: &str = r"[A-Za-z0-9][A-Za-z0-9._-]*";
const DATE: &str = r"\d{4}-\d{2}-\d{2}";
const DEP: &str = r"(?:blocked-by|parent|discovered-from)";

struct Pat {
    name: &'static str,
    src: String,
    global: bool,
    focus: &'static [&'static str],
}

const BULLET: &[&str] = &[
    "- [ ] ",
    "- [x] ",
    "- **",
    "- [X] ",
    "- [ ]",
    "-  [ ] ",
    "**",
    "** - ",
    "fix-login-k3",
    "a.b-c_d",
    " - ",
    " - text",
    "- ",
    "\r",
];

fn patterns() -> Vec<Pat> {
    let p = |name, src: String, global, focus| Pat {
        name,
        src,
        global,
        focus,
    };
    vec![
        p(
            "IN_FLIGHT_RE",
            format!(r"^- \*\*({ID})\*\* - (.*)$"),
            false,
            BULLET,
        ),
        p(
            "QUEUED_RE",
            format!(r"^- \[ \] ({ID}) - (.*)$"),
            false,
            BULLET,
        ),
        p(
            "DONE_RE",
            format!(r"^- \[x\] ({ID}) - (.*)$"),
            false,
            BULLET,
        ),
        p(
            "ID_RE",
            format!("^{ID}$"),
            false,
            &[
                "a",
                "Z9",
                "x.y_z-1",
                "-",
                ".",
                "_",
                "é",
                " ",
                "\n",
                "fix-login-k3",
            ],
        ),
        p(
            "TAIL_DEP",
            format!(r"\s*({DEP}):\s*({ID})(?:\s+-\s+((?:(?!\s+{DEP}:\s).)+?))?\s*$"),
            false,
            &[
                "blocked-by:",
                "parent:",
                "discovered-from:",
                " ",
                "fix-login-k3",
                " - ",
                "because",
                " blocked-by: ",
                " parent: z",
                "\t",
                "\u{a0}",
                "text",
                ":",
                "x - y",
            ],
        ),
        p(
            "TAIL_REPO",
            r"\s*\((?:[^()]*\+\s*)?repo:\s*([^)]+)\)\s*$".to_string(),
            false,
            &[
                "(repo: x)",
                "(a + repo: b)",
                "(",
                ")",
                " ",
                "repo:",
                "+",
                "x",
                "(repo:",
                "\t",
            ],
        ),
        p(
            "TAIL_KIND",
            r"\s*\(kind:\s*([^)]+)\)\s*$".to_string(),
            false,
            &[
                "(kind: y)",
                "(kind:",
                ")",
                " ",
                "x",
                "\u{3000}",
                "(kind:  z  )",
            ],
        ),
        p(
            "TAIL_PRIORITY",
            r"\s*\(priority:\s*([0-4])\)\s*$".to_string(),
            false,
            &[
                "(priority:",
                " ",
                "0",
                "3",
                "4",
                "5",
                "9",
                ")",
                "\u{a0}",
                "(priority: 2)",
            ],
        ),
        p(
            "TAIL_SINCE",
            format!(r"\s*\(since\s+({DATE})\)\s*$"),
            false,
            &[
                "(since",
                " ",
                "2026-01-02",
                "2026-1-02",
                ")",
                "\t",
                "x",
                "(since 2026-01-02)",
            ],
        ),
        p(
            "TAIL_CLOSED",
            format!(r"\s*\((?:merged|reported|done|closed)\s+({DATE})\)\s*$"),
            false,
            &[
                "(merged",
                "(reported",
                "(done",
                "(closed",
                "(since",
                " ",
                "2026-01-02",
                ")",
                "x",
                "\u{2003}",
            ],
        ),
        p(
            "TAIL_HOLD",
            r"\s*\(hold:\s*([^()]+)\)\s*$".to_string(),
            false,
            &["(hold:", " ", "why", "(", ")", "(hold: a b)", "x", "\u{a0}"],
        ),
        p(
            "TAIL_HOLD_KIND",
            format!(
                r"\s*\(hold-kind:\s*({})\)\s*$",
                "captain|external|load|parked|future"
            ),
            false,
            &[
                "(hold-kind:",
                " ",
                "captain",
                "external",
                "load",
                "parked",
                "future",
                "x",
                ")",
                "(hold-kind: load)",
            ],
        ),
        p(
            "TAIL_HOLD_UNTIL",
            format!(r"\s*\(hold-until:\s*({DATE})\)\s*$"),
            false,
            &[
                "(hold-until:",
                " ",
                "2026-12-31",
                "2026-12-3",
                ")",
                "x",
                "\t",
            ],
        ),
        p(
            "REPORT_LINK",
            r"\bdata\/\S+?\/report\.md\b".to_string(),
            true,
            &[
                "data/",
                "/report.md",
                "data/x/report.md",
                " ",
                "x",
                "report.mdx",
                "\u{a0}",
                "data/a b/report.md",
                "_",
                "-",
            ],
        ),
        p(
            "GENERIC_URL",
            r"https?:\/\/\S+".to_string(),
            true,
            &[
                "http://",
                "https://",
                "x.com/y",
                " ",
                "\u{a0}",
                "(",
                ")",
                ".",
                "http:/",
                "😀",
                "https://github.com/o/r/pull/1",
            ],
        ),
        p(
            "LEADING_KIND_PERSISTENT_SECONDMATE",
            r"^PERSISTENT SECONDMATE\b".to_string(),
            false,
            &[
                "PERSISTENT SECONDMATE",
                "PERSISTENT SECONDMATE ",
                "PERSISTENT SECONDMATES",
                "PERSISTENT SECONDMATE_",
                "-",
                " ",
                "x",
            ],
        ),
        p(
            "LEADING_KIND_SHIP",
            r"^SHIP\b".to_string(),
            false,
            &["SHIP", " ", "-", "S", "SHIPS", "_", "é", ":"],
        ),
        p(
            "LEADING_KIND_SCOUT",
            r"^SCOUT\b".to_string(),
            false,
            &["SCOUT", " ", "-", "SCOUTS", "_", "é", ":"],
        ),
        p(
            "LEADING_KIND_DOCS_ONLY",
            r"^DOCS-ONLY\b".to_string(),
            false,
            &["DOCS-ONLY", " ", "-", "DOCS-ONLYX", "_", "é", ":"],
        ),
        p(
            "TRIM_URL",
            r"[).,;]+$".to_string(),
            false,
            &[")", ".", ",", ";", "x", "https://a.b/c", " ", "\n"],
        ),
        p(
            "SECTION_HEADER",
            r"^##\s+(.*?)\s*$".to_string(),
            false,
            &[
                "## ", "##", "Heading", " ", "\t", "\u{a0}", "###", "  ", "a b", "\r", "\u{2028}",
                "😀",
            ],
        ),
        p(
            "BACKLOG_HEADER",
            r"^##\s+".to_string(),
            false,
            &["## ", "##", "###", " ", "\t", "\u{3000}", "x", "#"],
        ),
        p(
            "PUBLIC_FOLLOWUP_METADATA_RE",
            r"^<!-- tasks-axi:public-followup\/v(\d+):([A-Za-z0-9_-]+) -->$".to_string(),
            false,
            &[
                "<!-- tasks-axi:public-followup/v",
                "1",
                "12",
                ":",
                "ab_C-9",
                " -->",
                " ",
                "-->",
                "x",
                "<!-- tasks-axi:public-followup/v1:abc -->",
                "é",
                "\n",
            ],
        ),
        p(
            "PR_URL_RE",
            format!(
                r"^https://({h}(?:\.{h})*)/({s})/({s})/(pull|pulls)/([1-9][0-9]*)$",
                h = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
                s = "[A-Za-z0-9._-]+"
            ),
            false,
            &[
                "https://",
                "github.com",
                "example.org",
                "a-b.c",
                "-",
                "/",
                "o",
                "r.s",
                "..",
                ".",
                "pull",
                "pulls",
                "/pull/",
                "/pulls/",
                "12",
                "0",
                "07",
                "9",
                "x",
                "?q",
                "#f",
                ":80",
                "user@",
                "EXAMPLE.com",
                "https://github.com/o/r/pull/12",
                "a",
                "aa",
                "A",
                "https://example.org/o/r/pulls/3",
                "é",
                " ",
            ],
        ),
    ]
}

// ---- the test ---------------------------------------------------------------------

fn run() {
    if Command::new("node").arg("--version").output().is_err() {
        println!("SKIPPED: `node` not found on PATH; differential test not run");
        return;
    }
    let pats = patterns();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut cases: Vec<(usize, Vec<char>)> = Vec::new();
    let mut file = String::new();
    for (pi, pat) in pats.iter().enumerate() {
        for _ in 0..CASES_PER_PATTERN {
            let input = gen(&mut rng, pat.focus, skeleton(pat.name));
            file.push_str(&format!(
                "{{\"id\":{},\"src\":{},\"global\":{},\"input\":{}}}\n",
                cases.len(),
                json_str(&pat.src),
                pat.global,
                json_str(&input)
            ));
            cases.push((pi, input.chars().collect()));
        }
    }
    let scratch =
        std::env::var("DEV_SCRATCH").unwrap_or_else(|_| std::env::temp_dir().display().to_string());
    let dir = PathBuf::from(scratch).join(format!("jsre-diff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input_path = dir.join("cases.jsonl");
    std::fs::write(&input_path, file).unwrap();
    let oracle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/oracle.mjs");
    let out = Command::new("node")
        .arg(&oracle)
        .arg(&input_path)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        out.status.success(),
        "oracle failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = out.stdout;

    let regexes: Vec<Regex> = pats
        .iter()
        .map(|p| Regex::new(&p.src).unwrap_or_else(|e| panic!("{} did not compile: {}", p.name, e)))
        .collect();
    let mut compared = vec![0usize; pats.len()];
    let mut hit = vec![0usize; pats.len()];
    let mut mismatches: Vec<String> = Vec::new();
    let mut nmismatch = 0;
    let mut seen = 0;
    for line in stdout.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let mut p = 0;
        let J::Arr(top) = parse_json(line, &mut p) else {
            panic!("bad line")
        };
        let J::Num(id) = top[0] else { panic!("bad id") };
        let expected = to_matches(&top[1]);
        let (pi, hay) = &cases[id];
        let re = &regexes[*pi];
        let got: Vec<Groups> = if pats[*pi].global {
            re.find_all(hay).into_iter().map(|m| m.groups).collect()
        } else {
            re.find_at(hay, 0).into_iter().map(|m| m.groups).collect()
        };
        seen += 1;
        compared[*pi] += 1;
        if !expected.is_empty() {
            hit[*pi] += 1;
        }
        if expected != got {
            nmismatch += 1;
            if mismatches.len() < 10 {
                mismatches.push(format!(
                    "pattern {} ({})\n  input: {:?}\n  expected: {:?}\n  got:      {:?}",
                    pats[*pi].name,
                    pats[*pi].src,
                    hay.iter().collect::<String>(),
                    expected,
                    got
                ));
            }
        }
    }
    assert_eq!(
        seen,
        cases.len(),
        "oracle returned the wrong number of results"
    );
    println!("differential: compared {} cases against node", seen);
    for (i, p) in pats.iter().enumerate() {
        println!(
            "  {:<38} compared {:>5}  with-match {:>5}",
            p.name, compared[i], hit[i]
        );
    }
    if nmismatch > 0 {
        panic!(
            "{} mismatches; first {}:\n{}",
            nmismatch,
            mismatches.len(),
            mismatches.join("\n")
        );
    }
    for (i, p) in pats.iter().enumerate() {
        assert!(
            hit[i] >= 20,
            "{}: only {} inputs matched; generator too weak",
            p.name,
            hit[i]
        );
    }
}

#[test]
fn differential_against_node() {
    // Deep backtracking recursion: run on a thread with a generous stack.
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(run)
        .unwrap()
        .join()
        .unwrap();
}
