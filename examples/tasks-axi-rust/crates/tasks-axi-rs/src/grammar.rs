//! The markdown backlog grammar: sections, task bullets, indented bodies and the trailing inline
//! tags. A port of the Node tool's `markdown-grammar`, with JavaScript regex behaviour supplied
//! by `jsre` (differentially tested against node) so the tag grammar is not re-derived.

use crate::jsutil::{js_trim, semantic_line};
use jsre::Regex;
use tasks_axi_gen::enums::{DepType, HoldKind, LinkKind, TaskState};
use tasks_axi_gen::model::{Dep, Hold, Link, Task};

const ID: &str = r"[A-Za-z0-9][A-Za-z0-9._-]*";
const DATE: &str = r"\d{4}-\d{2}-\d{2}";
const DEP: &str = r"(?:blocked-by|parent|discovered-from)";
const PUBLIC_FOLLOWUP_KIND: &str = "public-followup";
const PUBLIC_FOLLOWUP_MARKER: &str = "tasks-axi:public-followup";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|e| panic!("grammar pattern {pattern:?}: {e}"))
}

/// Every pattern the grammar uses, compiled once per run.
pub struct Grammar {
    in_flight: Regex,
    queued: Regex,
    done: Regex,
    tail_dep: Regex,
    tail_repo: Regex,
    tail_kind: Regex,
    tail_priority: Regex,
    tail_since: Regex,
    tail_closed: Regex,
    tail_hold: Regex,
    tail_hold_kind: Regex,
    tail_hold_until: Regex,
    report_link: Regex,
    generic_url: Regex,
    leading_kind: Vec<(Regex, &'static str)>,
    trim_url: Regex,
    section_header: Regex,
    pr_url: Regex,
}

impl Grammar {
    pub fn new() -> Grammar {
        let hold_kinds: Vec<&str> = HoldKind::ALL.iter().map(|k| k.as_str()).collect();
        let host = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
        let segment = "[A-Za-z0-9._-]+";
        Grammar {
            in_flight: re(&format!(r"^- \*\*({ID})\*\* - (.*)$")),
            queued: re(&format!(r"^- \[ \] ({ID}) - (.*)$")),
            done: re(&format!(r"^- \[x\] ({ID}) - (.*)$")),
            tail_dep: re(&format!(
                r"\s*({DEP}):\s*({ID})(?:\s+-\s+((?:(?!\s+{DEP}:\s).)+?))?\s*$"
            )),
            tail_repo: re(r"\s*\((?:[^()]*\+\s*)?repo:\s*([^)]+)\)\s*$"),
            tail_kind: re(r"\s*\(kind:\s*([^)]+)\)\s*$"),
            tail_priority: re(r"\s*\(priority:\s*([0-4])\)\s*$"),
            tail_since: re(&format!(r"\s*\(since\s+({DATE})\)\s*$")),
            tail_closed: re(&format!(
                r"\s*\((?:merged|reported|done|closed)\s+({DATE})\)\s*$"
            )),
            tail_hold: re(r"\s*\(hold:\s*([^()]+)\)\s*$"),
            tail_hold_kind: re(&format!(
                r"\s*\(hold-kind:\s*({})\)\s*$",
                hold_kinds.join("|")
            )),
            tail_hold_until: re(&format!(r"\s*\(hold-until:\s*({DATE})\)\s*$")),
            report_link: re(r"\bdata\/\S+?\/report\.md\b"),
            generic_url: re(r"https?:\/\/\S+"),
            leading_kind: vec![
                (re(r"^PERSISTENT SECONDMATE\b"), "secondmate"),
                (re(r"^SHIP\b"), "ship"),
                (re(r"^SCOUT\b"), "scout"),
                (re(r"^DOCS-ONLY\b"), "docs"),
            ],
            trim_url: re(r"[).,;]+$"),
            section_header: re(r"^##\s+(.*?)\s*$"),
            pr_url: re(&format!(
                r"^https://({host}(?:\.{host})*)/({segment})/({segment})/(pull|pulls)/([1-9][0-9]*)$"
            )),
        }
    }

    fn leading_kind(&self, title: &[char]) -> Option<&'static str> {
        self.leading_kind
            .iter()
            .find(|(r, _)| r.find_at(title, 0).is_some())
            .map(|(_, kind)| *kind)
    }

    fn trim_url(&self, url: &str) -> String {
        let chars: Vec<char> = url.chars().collect();
        match self.trim_url.find_at(&chars, 0) {
            Some(m) => chars[..m.start].iter().collect(),
            None => url.to_string(),
        }
    }

    /// True when `url` is byte-for-byte a canonical GitHub or Forgejo pull request URL.
    fn is_pr_url(&self, url: &str) -> bool {
        let chars: Vec<char> = url.chars().collect();
        let Some(g) = self.pr_url.captures_str(&chars, 0) else {
            return false;
        };
        let get = |i: usize| g[i].as_deref().unwrap_or("");
        let (host, owner, repo, route) = (get(1), get(2), get(3), get(4));
        if owner == "." || owner == ".." || repo == "." || repo == ".." {
            return false;
        }
        if route == "pull" {
            host == "github.com"
        } else {
            host != "github.com"
        }
    }

    /// Typed links derived from prose: pull requests, then reports, then other URLs.
    fn derive_links(&self, text: &[char]) -> Vec<Link> {
        let mut links: Vec<Link> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut add = |this: &Grammar, kind: LinkKind, raw: &str| {
            let url = this.trim_url(raw);
            if seen.contains(&url) {
                return;
            }
            seen.push(url.clone());
            links.push(Link { kind, url });
        };
        let slice = |s: usize, e: usize| -> String { text[s..e].iter().collect() };
        for m in self.generic_url.find_all(text) {
            let raw = slice(m.start, m.end);
            if self.is_pr_url(&self.trim_url(&raw)) {
                add(self, LinkKind::Pr, &raw);
            }
        }
        for m in self.report_link.find_all(text) {
            add(self, LinkKind::Report, &slice(m.start, m.end));
        }
        for m in self.generic_url.find_all(text) {
            let raw = slice(m.start, m.end);
            if !self.is_pr_url(&self.trim_url(&raw)) {
                add(self, LinkKind::Doc, &raw);
            }
        }
        links
    }
}

impl Default for Grammar {
    fn default() -> Self {
        Grammar::new()
    }
}

/// What `extractTags` found on a bullet's content.
struct Tags {
    title: String,
    kind: Option<String>,
    repo: Option<String>,
    deps: Vec<Dep>,
    created: Option<String>,
    closed: Option<String>,
    priority: Option<i64>,
    hold: Option<Hold>,
    links: Vec<Link>,
}

fn cap(groups: &[Option<String>], i: usize) -> Option<String> {
    groups.get(i).cloned().flatten()
}

/// Strip the trailing tag region off `rest`, one tag at a time, in the Node tool's order.
fn extract_tags(g: &Grammar, rest: &str) -> Tags {
    let mut deps: Vec<Dep> = Vec::new();
    let (mut repo, mut kind_tag, mut created, mut closed, mut priority) =
        (None, None, None, None, None);
    let (mut hold_reason, mut hold_kind, mut hold_until): (
        Option<String>,
        Option<String>,
        Option<String>,
    ) = (None, None, None);
    let mut title: Vec<char> = rest.chars().collect();

    loop {
        // (regex, handler) in the order the Node tool tries them; the first that matches strips
        // its tail and the scan restarts.
        if let Some(m) = g.tail_dep.find_at(&title, 0) {
            let caps = captures(&title, &m);
            let dep_type = DepType::parse(caps[1].as_deref().unwrap_or(""));
            if let Some(t) = dep_type {
                deps.insert(
                    0,
                    Dep {
                        r#type: t,
                        id: cap(&caps, 2).unwrap_or_default(),
                        reason: cap(&caps, 3),
                    },
                );
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_repo.find_at(&title, 0) {
            if repo.is_none() {
                repo = cap(&captures(&title, &m), 1).map(|s| js_trim(&s).to_string());
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_kind.find_at(&title, 0) {
            if kind_tag.is_none() {
                kind_tag = cap(&captures(&title, &m), 1).map(|s| js_trim(&s).to_string());
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_priority.find_at(&title, 0) {
            if priority.is_none() {
                priority = cap(&captures(&title, &m), 1).and_then(|s| s.parse::<i64>().ok());
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_since.find_at(&title, 0) {
            if created.is_none() {
                created = cap(&captures(&title, &m), 1);
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_closed.find_at(&title, 0) {
            if closed.is_none() {
                closed = cap(&captures(&title, &m), 1);
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_hold_until.find_at(&title, 0) {
            if hold_until.is_none() {
                hold_until = cap(&captures(&title, &m), 1);
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_hold_kind.find_at(&title, 0) {
            if hold_kind.is_none() {
                hold_kind = cap(&captures(&title, &m), 1);
            }
            title.truncate(m.start);
            continue;
        }
        if let Some(m) = g.tail_hold.find_at(&title, 0) {
            if hold_reason.is_none() {
                hold_reason = cap(&captures(&title, &m), 1).map(|s| js_trim(&s).to_string());
            }
            title.truncate(m.start);
            continue;
        }
        break;
    }

    let title_text: String = title.iter().collect();
    let title_trimmed = js_trim(&title_text).to_string();
    let trimmed_chars: Vec<char> = title_trimmed.chars().collect();
    // `kindTag ?? leadingKind(title)`: a present-but-empty tag wins and is then falsy.
    let kind = kind_tag.or_else(|| g.leading_kind(&trimmed_chars).map(str::to_string));
    let links = g.derive_links(&trimmed_chars);
    let hold = hold_reason.map(|reason| Hold {
        reason,
        kind: hold_kind.as_deref().and_then(HoldKind::parse),
        until: hold_until,
    });
    Tags {
        title: title_trimmed,
        kind,
        repo,
        deps,
        created,
        closed,
        priority,
        hold,
        links,
    }
}

fn captures(hay: &[char], m: &jsre::Match) -> Vec<Option<String>> {
    m.groups
        .iter()
        .map(|g| g.map(|(s, e)| hay[s..e].iter().collect()))
        .collect()
}

/// A parsed backlog: its tasks in document order, and whether it holds anything this port refuses.
pub struct Backlog {
    pub tasks: Vec<Task>,
    /// A `public-followup` task or its metadata marker is present (not implemented here).
    pub has_public_followup: bool,
}

fn section_state(g: &Grammar, header: &str) -> Option<TaskState> {
    let chars: Vec<char> = semantic_line(header).chars().collect();
    let groups = g.section_header.captures_str(&chars, 0)?;
    let text = groups.get(1).cloned().flatten()?.to_lowercase();
    if text == "in flight" {
        Some(TaskState::InFlight)
    } else if text == "queued" {
        Some(TaskState::Queued)
    } else if text.starts_with("done") {
        Some(TaskState::Done)
    } else {
        None
    }
}

fn is_section_header(line: &str) -> bool {
    match semantic_line(line).strip_prefix("##") {
        Some(rest) => rest.chars().next().is_some_and(crate::jsutil::is_js_space),
        None => false,
    }
}

fn match_bullet(g: &Grammar, line: &str, state: TaskState) -> Option<(String, String)> {
    let chars: Vec<char> = semantic_line(line).chars().collect();
    let pick = |re: &Regex| -> Option<(String, String)> {
        let c = re.captures_str(&chars, 0)?;
        Some((cap(&c, 1)?, cap(&c, 2)?))
    };
    match state {
        TaskState::Done => pick(&g.done),
        TaskState::Queued => pick(&g.queued),
        TaskState::InFlight => pick(&g.in_flight).or_else(|| pick(&g.queued)),
    }
}

/// `parseBacklog` followed by `allTasks`: every task bullet under a recognised section.
pub fn parse_backlog(g: &Grammar, src: &str) -> Backlog {
    let mut backlog = Backlog {
        tasks: Vec::new(),
        has_public_followup: false,
    };
    if src.is_empty() {
        return backlog;
    }
    let body = src.strip_suffix('\n').unwrap_or(src);
    let lines: Vec<&str> = body.split('\n').collect();

    let mut state: Option<TaskState> = None;
    let mut in_section = false;
    let mut buffer: Vec<&str> = Vec::new();
    let close = |state: Option<TaskState>, buffer: &mut Vec<&str>, backlog: &mut Backlog| {
        parse_entries(g, buffer, state, backlog);
        buffer.clear();
    };
    for line in lines {
        if is_section_header(line) {
            if in_section {
                close(state, &mut buffer, &mut backlog);
            }
            in_section = true;
            state = section_state(g, line);
            continue;
        }
        if in_section {
            buffer.push(line);
        }
    }
    if in_section {
        close(state, &mut buffer, &mut backlog);
    }
    backlog
}

fn parse_entries(g: &Grammar, lines: &[&str], state: Option<TaskState>, backlog: &mut Backlog) {
    let Some(state) = state else { return };
    let mut i = 0;
    while i < lines.len() {
        let Some((id, rest)) = match_bullet(g, lines[i], state) else {
            i += 1;
            continue;
        };
        let mut body_lines: Vec<String> = Vec::new();
        while i + 1 < lines.len() {
            let next = semantic_line(lines[i + 1]);
            if js_trim(next).is_empty() {
                i += 1;
                body_lines.push(String::new());
                continue;
            }
            if let Some(stripped) = next.strip_prefix("  ") {
                i += 1;
                body_lines.push(stripped.to_string());
                continue;
            }
            break;
        }
        i += 1;
        let tags = extract_tags(g, &rest);
        if body_lines
            .iter()
            .any(|l| l.contains(PUBLIC_FOLLOWUP_MARKER))
            || tags.kind.as_deref() == Some(PUBLIC_FOLLOWUP_KIND)
        {
            backlog.has_public_followup = true;
        }
        backlog.tasks.push(build_task(id, tags, state, body_lines));
    }
}

fn build_task(id: String, tags: Tags, state: TaskState, mut body_lines: Vec<String>) -> Task {
    while body_lines.last().is_some_and(String::is_empty) {
        body_lines.pop();
    }
    let body = if body_lines.is_empty() {
        None
    } else {
        Some(body_lines.join("\n"))
    };
    Task {
        id,
        title: tags.title,
        state,
        kind: tags.kind.filter(|k| !k.is_empty()),
        repo: tags.repo.filter(|r| !r.is_empty()),
        priority: tags.priority,
        created: tags.created,
        closed: tags.closed,
        body,
        hold: tags.hold,
        deps: tags.deps,
        links: tags.links,
    }
}
