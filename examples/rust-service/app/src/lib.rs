//! The part of the tasks API the model cannot say: who a caller is, what they may do, and the
//! table the rows live in. Everything it calls is generated from `metaobjects/meta.app.yaml` into
//! `generated/` by `cargo meta gen`: the `Task` type and its validation (`tasks`), the store
//! (`tasks_store`), the lifecycle's names (`tasks_rules`), the service that runs every write in a
//! transaction with the rules checked (`tasks_service`) and the axum routes over it (`tasks_http`).

use axum::http::HeaderMap;
use serde_json::Value;
use sqlx::SqliteConnection;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use tasks_rules::Permission;
use tasks_service::{TasksError, TasksPolicy, TasksService};

/// The table `Task` is stored in. Migrations are the project's own; the Node `meta migrate`
/// would propose this from the model.
pub const SCHEMA: &str = r#"CREATE TABLE IF NOT EXISTS "tasks" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo'
);
"#;

/// Who a request runs for.
pub struct User {
    pub name: String,
    /// A team lead, who may finish a task.
    pub lead: bool,
}

/// The caller, from the `x-user` header (absent or empty: nobody) and `x-role: lead`.
pub fn user(headers: &HeaderMap) -> Option<User> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = header("x-user");
    if name.is_empty() {
        return None;
    }
    Some(User { name: name.to_string(), lead: header("x-role") == "lead" })
}

/// Anyone signed in may start a task, and only a lead may finish one. Reopening a done task is
/// `public` in the model, so the service never asks.
pub struct Team;

impl TasksPolicy<User, SqliteConnection> for Team {
    async fn allows<'a>(
        &'a self,
        permission: Permission,
        actor: Option<&'a User>,
        _row: Option<&'a Value>,
        _input: Option<&'a Value>,
        _conn: &'a mut SqliteConnection,
    ) -> Result<bool, TasksError> {
        Ok(match (permission, actor) {
            (_, None) => false,
            (Permission::TasksTaskStart, Some(_)) => true,
            (Permission::TasksTaskFinish, Some(user)) => user.lead,
        })
    }
}

/// A pool on `url` with the table in place. One connection, kept open, so an in-memory database
/// lives as long as the app.
pub async fn database(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect(url)
        .await?;
    sqlx::raw_sql(SCHEMA).execute(&pool).await?;
    Ok(pool)
}

/// The API, to mount under `/api`.
pub fn app(pool: SqlitePool) -> axum::Router {
    tasks_http::router(TasksService::new(pool, Team), meta_http::ActorFn(user))
}
