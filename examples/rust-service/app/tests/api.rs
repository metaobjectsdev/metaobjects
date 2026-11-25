//! The tasks API over HTTP: a create, the list's REST-standard query, a refused body, and the
//! lifecycle with its permission points.

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The app on a free port, served for the rest of the test.
async fn serve() -> String {
    let pool = tasks_app::database("sqlite::memory:").await.unwrap();
    let app = axum::Router::new().nest("/api", tasks_app::app(pool));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

/// One request: the status and the body read as JSON (`null` for an empty body).
async fn send(addr: &str, method: &str, path: &str, user: &[(&str, &str)], body: Option<Value>) -> (u16, Value) {
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: tasks\r\nConnection: close\r\n");
    for (k, v) in user {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    let (head, rest) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    // axum sends a JSON body with a length, so the body is the rest as it is.
    (status, serde_json::from_str(rest).unwrap_or(Value::Null))
}

const ADA: &[(&str, &str)] = &[("x-user", "ada")];
const LEAD: &[(&str, &str)] = &[("x-user", "grace"), ("x-role", "lead")];

#[tokio::test(flavor = "current_thread")]
async fn a_task_is_written_listed_and_moved_through_its_lifecycle() {
    let addr = serve().await;

    let (status, task) = send(&addr, "POST", "/api/tasks", ADA, Some(json!({ "title": "Write the docs" }))).await;
    assert_eq!(status, 201, "{task}");
    assert_eq!(task["status"], "todo", "a create starts the lifecycle in its initial state");
    let id = task["id"].as_i64().unwrap();
    send(&addr, "POST", "/api/tasks", ADA, Some(json!({ "title": "Ship it" }))).await;

    // The list query is the REST standard's: a filter, a sort, a page and the total.
    let (status, page) = send(&addr, "GET", "/api/tasks?filter[title][like]=Ship%25&sort=title:desc&withCount=true", &[], None).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!((page["total"].clone(), page["rows"][0]["title"].clone()), (json!(1), json!("Ship it")));

    // What the model refuses, the route refuses with a named body.
    let (status, refused) = send(&addr, "POST", "/api/tasks", ADA, Some(json!({ "title": "x", "owner": "ada" }))).await;
    assert_eq!((status, refused["error"].clone()), (400, json!("unknown_fields")), "{refused}");
    let (status, refused) = send(&addr, "GET", "/api/tasks?filter[notes][eq]=x", &[], None).await;
    assert_eq!((status, refused["error"].clone()), (400, json!("invalid_filter_field")), "{refused}");

    // Starting needs a caller; finishing needs a lead; the service checks, not the route.
    let start = format!("/api/tasks/{id}/start");
    let finish = format!("/api/tasks/{id}/finish");
    assert_eq!(send(&addr, "POST", &start, &[], None).await.0, 403);
    let (status, task) = send(&addr, "POST", &start, ADA, None).await;
    assert_eq!((status, task["status"].clone()), (200, json!("doing")), "{task}");
    let (status, refused) = send(&addr, "POST", &start, ADA, None).await;
    assert_eq!((status, refused["error"].clone()), (409, json!("invalid_transition")), "{refused}");
    assert_eq!(send(&addr, "POST", &finish, ADA, None).await.0, 403);
    let (status, task) = send(&addr, "POST", &finish, LEAD, None).await;
    assert_eq!((status, task["status"].clone()), (200, json!("done")), "{task}");

    // A generic update never moves a lifecycle.
    let (status, refused) = send(&addr, "PATCH", &format!("/api/tasks/{id}"), ADA, Some(json!({ "status": "todo" }))).await;
    assert_eq!((status, refused["error"].clone()), (409, json!("state_managed")), "{refused}");
    // Reopening is public.
    let (status, task) = send(&addr, "POST", &format!("/api/tasks/{id}/reopen"), &[], None).await;
    assert_eq!((status, task["status"].clone()), (200, json!("todo")), "{task}");
}
