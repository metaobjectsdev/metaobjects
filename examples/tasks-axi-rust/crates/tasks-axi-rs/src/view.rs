//! Task to printed row, and rows to TOON.

use crate::derive::{active_blockers, is_hold_active};
use crate::jsutil::{slice_utf16, utf16_len};
use tasks_axi_gen::cli::OutputSpec;
use tasks_axi_gen::errors::AxiError;
use tasks_axi_gen::model::Task;
use tasks_axi_gen::rows::{Cell, Column, TaskRow};
use toon_encode::{Dialect, Options, Value};

/// The shipped `@toon-format/toon` 2.3.x quoting rules, which differ from the spec's.
fn toon_options() -> Options {
    Options {
        dialect: Dialect::ToonJs2,
        ..Options::default()
    }
}

fn encode(value: &Value) -> String {
    toon_encode::encode_with(value, &toon_options())
}

/// Shorten `text` to `limit` UTF-16 units and say how much was lost and how to get it back.
pub fn truncate(text: &str, limit: usize, hint: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let len = utf16_len(text);
    if len <= limit {
        return text.to_string();
    }
    format!(
        "{}\n... (truncated, {len} chars total - {hint})",
        slice_utf16(text, limit)
    )
}

/// The hint a list row's truncation carries.
pub fn show_full_text_hint(task: &Task) -> String {
    format!("use show {} --full to see complete text", task.id)
}

/// The hint `show` carries when it truncates a field.
pub const DEFAULT_TRUNCATION_HINT: &str = "use --full to see complete text";

/// `toRow`: the flat record carrying every derivable column.
pub fn to_row(
    task: &Task,
    all: &[Task],
    full: bool,
    hint: &str,
    today: &dyn Fn() -> String,
) -> TaskRow {
    let blockers = active_blockers(task, all);
    let title_limit = Column::Title.truncate_limit().unwrap_or(usize::MAX);
    let body_limit = Column::Body.truncate_limit().unwrap_or(usize::MAX);
    let body = task.body.as_deref().unwrap_or("");
    TaskRow {
        id: task.id.clone(),
        title: if full {
            task.title.clone()
        } else {
            truncate(&task.title, title_limit, hint)
        },
        state: task.state,
        blocked: !blockers.is_empty(),
        blocked_by: blockers,
        held: is_hold_active(task, today),
        hold_reason: task.hold.as_ref().map(|h| h.reason.clone()),
        hold_kind: task.hold.as_ref().and_then(|h| h.kind),
        hold_until: task.hold.as_ref().and_then(|h| h.until.clone()),
        kind: Some(task.kind.clone().unwrap_or_else(|| "task".to_string())),
        repo: task.repo.clone(),
        priority: task.priority,
        created: task.created.clone(),
        closed: task.closed.clone(),
        delivery_state: None,
        deps: task
            .deps
            .iter()
            .map(|d| format!("{}:{}", d.r#type.as_str(), d.id))
            .collect(),
        links: task
            .links
            .iter()
            .map(|l| format!("{}:{}", l.kind.as_str(), l.url))
            .collect(),
        body: Some(if full {
            body.to_string()
        } else {
            truncate(body, body_limit, hint)
        }),
    }
}

fn cell_value(cell: Cell) -> Value {
    match cell {
        Cell::Str(s) => Value::Str(s),
        Cell::Int(n) => Value::Int(n),
    }
}

fn row_value(row: &TaskRow, columns: &[Column]) -> Value {
    Value::Object(
        columns
            .iter()
            .map(|c| (c.name().to_string(), cell_value(row.cell(*c))))
            .collect(),
    )
}

/// `renderList`: a labeled array of rows. The columns are the spec's, then any `extra`.
pub fn render_list(spec: &OutputSpec, rows: &[TaskRow], extra: &[Column]) -> String {
    let mut columns: Vec<Column> = spec.columns.to_vec();
    columns.extend_from_slice(extra);
    encode(&Value::Object(vec![(
        spec.label.to_string(),
        Value::Array(rows.iter().map(|r| row_value(r, &columns)).collect()),
    )]))
}

/// `renderDetail`: one labeled record.
pub fn render_detail(spec: &OutputSpec, row: &TaskRow) -> String {
    encode(&Value::Object(vec![(
        spec.label.to_string(),
        row_value(row, spec.columns),
    )]))
}

/// `renderScalar`: `label: text`.
pub fn render_scalar(label: &str, text: &str) -> String {
    encode(&Value::Object(vec![(
        label.to_string(),
        Value::Str(text.to_string()),
    )]))
}

/// `renderHelp`: suggestions as a one-item-per-line array, or nothing.
pub fn render_help(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let items: Vec<String> = lines
        .iter()
        .map(|l| {
            format!(
                "  - {}",
                toon_encode::encode_scalar_with(&Value::Str(l.clone()), &toon_options())
            )
        })
        .collect();
    format!("help[{}]:\n{}", lines.len(), items.join("\n"))
}

/// `renderOutput`: the non-empty blocks, one per line group.
pub fn render_output(blocks: Vec<String>) -> String {
    blocks
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The error block: `error`, `code` and, when there are suggestions, `help`.
pub fn render_error(e: &AxiError) -> String {
    let mut fields = vec![
        ("error".to_string(), Value::Str(e.message.clone())),
        ("code".to_string(), Value::Str(e.code.as_str().to_string())),
    ];
    if !e.suggestions.is_empty() {
        fields.push((
            "help".to_string(),
            Value::Array(
                e.suggestions
                    .iter()
                    .map(|s| Value::Str(s.clone()))
                    .collect(),
            ),
        ));
    }
    encode(&Value::Object(fields))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_names_the_size_and_the_escape_hatch() {
        let text = "x".repeat(90);
        assert_eq!(
            truncate(&text, 80, "use --full"),
            format!(
                "{}\n... (truncated, 90 chars total - use --full)",
                "x".repeat(80)
            )
        );
        assert_eq!(truncate("short", 80, "h"), "short");
        assert_eq!(truncate("", 80, "h"), "");
    }
}
