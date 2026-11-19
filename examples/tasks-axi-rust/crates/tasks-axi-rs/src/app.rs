//! The read commands over the markdown backlog: the hand-written half of the generated
//! `Handlers` trait.

use crate::config::{check_archives, read_file_safe, resolve_config, Config, Env};
use crate::derive::{blocked_ids, held_tasks, local_date, ready_tasks};
use crate::grammar::{parse_backlog, Grammar};
use crate::suggest::{suggestions, HintContext};
use crate::view::{
    render_detail, render_help, render_list, render_output, render_scalar, show_full_text_hint,
    to_row, DEFAULT_TRUNCATION_HINT,
};
use tasks_axi_gen::cli::{
    Globals, HintWhen, ListArgs, ReadyArgs, ShowArgs, LIST_HINTS, LIST_OUTPUTS, READY_HINTS,
    READY_OUTPUTS, SHOW_HINTS, SHOW_OUTPUTS,
};
use tasks_axi_gen::dispatch::Handlers;
use tasks_axi_gen::enums::{ListState, TaskState};
use tasks_axi_gen::errors::{AxiError, ErrorCode};
use tasks_axi_gen::model::Task;
use tasks_axi_gen::rows::TaskRow;

/// The backend the Node tool ships; the only one this port reads.
const SUPPORTED_BACKEND: &str = "markdown";

pub struct App {
    env: Env,
    globals: Globals,
    config: Option<Config>,
}

impl App {
    pub fn new(env: Env) -> App {
        App {
            env,
            globals: Globals::default(),
            config: None,
        }
    }

    /// The backlog's tasks, refusing one that holds an unimplemented task kind.
    fn load(&self) -> Result<Vec<Task>, AxiError> {
        let config = self.config.as_ref().ok_or_else(|| {
            AxiError::new(
                "backlog context was not resolved",
                ErrorCode::Unknown,
                vec![],
            )
        })?;
        let src = read_file_safe(&config.path)?.unwrap_or_default();
        let backlog = parse_backlog(&Grammar::new(), &src);
        if backlog.has_public_followup {
            return Err(AxiError::new(
                "This backlog holds public-followup tasks, which tasks-axi-rs does not read",
                ErrorCode::Unsupported,
                vec!["Run the same command with the Node tasks-axi".to_string()],
            ));
        }
        Ok(backlog.tasks)
    }

    /// Suggestions only carry the globals when one was passed.
    fn suggestion_globals(&self) -> Option<&Globals> {
        (self.globals.backend.is_some() || self.globals.file.is_some()).then_some(&self.globals)
    }
}

impl Handlers for App {
    fn resolve_context(&mut self, globals: &Globals) -> Result<(), AxiError> {
        self.globals = globals.clone();
        let config = resolve_config(globals, &self.env)?;
        if config.backend != SUPPORTED_BACKEND {
            return Err(AxiError::new(
                format!(
                    "Unsupported backend \"{}\" \u{2014} P1 ships the markdown backend only",
                    config.backend
                ),
                ErrorCode::Unsupported,
                vec!["Set `backend = \"markdown\"` in .tasks.toml, or omit --backend".to_string()],
            ));
        }
        check_archives(&config)?;
        self.config = Some(config);
        Ok(())
    }

    fn show(&mut self, args: ShowArgs) -> Result<String, AxiError> {
        let all = self.load()?;
        let Some(task) = all.iter().find(|t| t.id == args.id) else {
            let lines = vec!["Run `tasks-axi list` to see existing tasks".to_string()];
            return Err(AxiError::new(
                format!("Task \"{}\" not found in this backlog", args.id),
                ErrorCode::NotFound,
                crate::suggest::with_globals(lines, self.suggestion_globals()),
            ));
        };
        let is_blocked = blocked_ids(&all).contains(&args.id);
        let row = to_row(task, &all, args.full, DEFAULT_TRUNCATION_HINT, &local_date);
        let mut blocks = vec![render_detail(&SHOW_OUTPUTS[0], &row)];
        let active: &[HintWhen] = if is_blocked {
            &[HintWhen::Blocked]
        } else {
            &[]
        };
        let help = suggestions(
            SHOW_HINTS,
            &HintContext {
                active,
                id: Some(&args.id),
                filters: &[],
                globals: self.suggestion_globals(),
            },
        );
        if !help.is_empty() {
            blocks.push(render_help(&help));
        }
        Ok(render_output(blocks))
    }

    fn list(&mut self, args: ListArgs) -> Result<String, AxiError> {
        let all = self.load()?;
        let blocked = blocked_ids(&all);
        let held: Vec<&str> = held_tasks(&all, &local_date)
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        let mut matched: Vec<&Task> = all.iter().collect();
        match args.state {
            Some(ListState::Held) => matched.retain(|t| held.contains(&t.id.as_str())),
            Some(state) => matched.retain(|t| t.state.as_str() == state.as_str()),
            None => {}
        }
        if let Some(repo) = &args.repo {
            matched.retain(|t| t.repo.as_deref() == Some(repo.as_str()));
        }
        if let Some(kind) = &args.kind {
            matched.retain(|t| t.kind.as_deref().unwrap_or("task") == kind);
        }
        if args.blocked {
            matched.retain(|t| blocked.contains(&t.id));
        }
        let total = matched.len();
        let items: Vec<&Task> = match args.limit {
            Some(limit) => matched.iter().take(limit as usize).copied().collect(),
            None => matched,
        };
        let is_empty = total == 0;
        let count_line = if total != items.len() {
            format!("count: {} of {total} total", items.len())
        } else {
            format!("count: {}", items.len())
        };

        let mut blocks = vec![count_line];
        if is_empty {
            blocks.push(render_scalar("tasks", &empty_state(&args)));
        } else {
            let rows: Vec<TaskRow> = items
                .iter()
                .map(|t| to_row(t, &all, false, &show_full_text_hint(t), &local_date))
                .collect();
            blocks.push(render_list(&LIST_OUTPUTS[0], &rows, &args.fields));
        }
        let mut filters: Vec<(&'static str, &str)> = Vec::new();
        if let Some(s) = args.state {
            filters.push(("state", s.as_str()));
        }
        if let Some(r) = &args.repo {
            filters.push(("repo", r));
        }
        if let Some(k) = &args.kind {
            filters.push(("kind", k));
        }
        blocks.push(render_help(&suggestions(
            LIST_HINTS,
            &HintContext {
                active: if is_empty {
                    &[HintWhen::Empty]
                } else {
                    &[HintWhen::NonEmpty]
                },
                id: None,
                filters: &filters,
                globals: self.suggestion_globals(),
            },
        )));
        Ok(render_output(blocks))
    }

    fn ready(&mut self, args: ReadyArgs) -> Result<String, AxiError> {
        let all = self.load()?;
        let blocked = blocked_ids(&all);
        let mut items = ready_tasks(&all, false, &local_date);
        let mut held: Vec<&Task> = held_tasks(&all, &local_date)
            .into_iter()
            .filter(|t| {
                t.state == TaskState::Queued
                    && t.kind.as_deref() != Some("public-followup")
                    && !blocked.contains(&t.id)
            })
            .collect();
        if let Some(repo) = &args.repo {
            items.retain(|t| t.repo.as_deref() == Some(repo.as_str()));
            held.retain(|t| t.repo.as_deref() == Some(repo.as_str()));
        }
        let is_empty = items.is_empty();
        let rows_of = |tasks: &[&Task]| -> Vec<TaskRow> {
            tasks
                .iter()
                .map(|t| to_row(t, &all, false, &show_full_text_hint(t), &local_date))
                .collect()
        };

        let mut blocks = vec![format!("count: {}", items.len())];
        if is_empty {
            blocks.push("ready: 0 unblocked queued tasks".to_string());
        } else {
            blocks.push(render_list(&READY_OUTPUTS[0], &rows_of(&items), &[]));
        }
        // Public-followup tasks make the backlog unreadable here (see `load`), so this group is
        // always the empty one.
        blocks.push("ready_public_followups: 0 delivery-ready obligations".to_string());
        if args.include_held && !held.is_empty() {
            blocks.push(render_list(&READY_OUTPUTS[2], &rows_of(&held), &[]));
        }
        let mut filters: Vec<(&'static str, &str)> = Vec::new();
        if let Some(r) = &args.repo {
            filters.push(("repo", r));
        }
        blocks.push(render_help(&suggestions(
            READY_HINTS,
            &HintContext {
                active: if is_empty {
                    &[HintWhen::Empty]
                } else {
                    &[HintWhen::NonEmpty]
                },
                id: None,
                filters: &filters,
                globals: self.suggestion_globals(),
            },
        )));
        Ok(render_output(blocks))
    }
}

/// `0 <qualifiers> tasks in this backlog`.
fn empty_state(args: &ListArgs) -> String {
    let qualifiers: Vec<String> = [
        args.blocked.then(|| "blocked".to_string()),
        args.state.map(|s| s.as_str().to_string()),
        args.kind.as_ref().map(|k| format!("kind={k}")),
        args.repo.as_ref().map(|r| format!("repo={r}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let scope = if qualifiers.is_empty() {
        String::new()
    } else {
        format!("{} ", qualifiers.join(" "))
    };
    format!("0 {scope}tasks in this backlog")
}
