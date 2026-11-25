//! Serves the tasks API under `/api`: `DATABASE_URL` (default an in-memory SQLite database) and
//! `ADDR` (default `127.0.0.1:3000`).

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite::memory:".to_string());
    let addr = std::env::var("ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let pool = tasks_app::database(&url).await?;
    let app = axum::Router::new().nest("/api", tasks_app::app(pool));
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("tasks API on http://{}/api/tasks", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
