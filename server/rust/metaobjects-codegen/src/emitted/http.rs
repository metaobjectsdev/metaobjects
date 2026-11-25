//! The REST mechanics the `service-routes` generator's crates share (ADR-0067 layer 5): how a
//! request becomes a call on a generated service, and how what the service answered becomes a
//! response.
//!
//! The routes are written into each package's transport crate; this crate holds only what every
//! one of them shares, so each refusal has one spelling in every app: the list query's named 400s
//! ([`list_query`]), `invalid_json`, `invalid_id`, `unknown_fields`, a `validation` 400 listing
//! every issue, `constraint_violation`, `method_not_allowed`, and a 500 that names nothing
//! (`internal`). It holds no rules: those are the service's.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use meta_service::{Page, ServiceError};
use meta_store::{Filter, Op, StoreError};
use meta_support::validation::{self, Violation};
// The list query reads decimals, durations and formats through these.
use meta_support::wire;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

mod list_query;

pub use list_query::{FilterRule, Kind, ListQuery, ListSpec, Node, Refusal, Search, Sort, SortRule};

/// Who a request runs for, read from the request: the app's own authentication. The routes hand
/// the actor to the service untouched, which hands it to the policy, the bodies, the hooks and the
/// event hook. `()` is the source that finds no actor, which a policy may refuse.
pub trait ActorSource<A>: Send + Sync + 'static {
    fn actor(&self, headers: &HeaderMap) -> Option<A>;
}

impl<A> ActorSource<A> for () {
    fn actor(&self, _headers: &HeaderMap) -> Option<A> {
        None
    }
}

/// An [`ActorSource`] that is a function of the headers.
pub struct ActorFn<F>(pub F);

impl<A, F> ActorSource<A> for ActorFn<F>
where
    F: Fn(&HeaderMap) -> Option<A> + Send + Sync + 'static,
{
    fn actor(&self, headers: &HeaderMap) -> Option<A> {
        (self.0)(headers)
    }
}

/// What a body may carry, for one entity's create or update route.
pub struct BodySpec {
    /// Every field the entity declares: any other key is unknown.
    pub declared: &'static [&'static str],
    /// The keys a create keeps. A declared key the client may not set is dropped, never refused.
    pub create: &'static [&'static str],
    /// The keys a create must carry, not null.
    pub create_required: &'static [&'static str],
    /// The keys an update keeps.
    pub update: &'static [&'static str],
    /// The keys an update may omit but may not set to null.
    pub update_not_null: &'static [&'static str],
    /// `api.unknownFields: reject` (the default): a body with an undeclared key is refused.
    pub reject_unknown: bool,
}

/// A response with a JSON body.
pub fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn refuse(status: StatusCode, code: &str) -> Response {
    reply(status, json!({ "error": code }))
}

/// `405 method_not_allowed`: the write verbs of a read-only route.
pub async fn method_not_allowed() -> Response {
    refuse(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed")
}

/// `400 invalid_id`: an `{id}` the key cannot hold.
pub fn invalid_id() -> Response {
    refuse(StatusCode::BAD_REQUEST, "invalid_id")
}

/// The whole-number key `text` spells: an optional `-` and ASCII digits with no leading zero,
/// no exponent, hex, plus sign, whitespace or negative zero.
pub fn int_key(text: &str) -> Result<i64, Response> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let canonical = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
        && text != "-0";
    match canonical.then(|| text.parse::<i64>().ok()).flatten() {
        Some(key) => Ok(key),
        None => Err(invalid_id()),
    }
}

/// The text key `text` names: any text.
pub fn text_key(text: &str) -> Result<String, Response> {
    Ok(text.to_string())
}

/// A list query and whether its count was asked for, ready for a service's list call.
pub struct Listed {
    pub query: meta_store::Query,
    pub with_count: bool,
}

/// Parse a list route's query string against `spec`: the store query, or the named 400.
pub fn list(raw: Option<&str>, spec: &ListSpec) -> Result<Listed, Response> {
    let parsed = list_query::parse(raw.unwrap_or(""), spec)
        .map_err(|r| reply(StatusCode::BAD_REQUEST, r.body()))?;
    let mut filters: Vec<Filter> = parsed.filter.map(filter).into_iter().collect();
    if let Some(search) = parsed.search {
        let fields = search.fields.iter().map(|f| f.to_string()).collect();
        filters.push(Filter::Search { term: search.term, fields });
    }
    let filter = match filters.len() {
        0 => None,
        1 => filters.pop(),
        _ => Some(Filter::And(filters)),
    };
    let sort = parsed
        .sort
        .map(|s| meta_store::Sort { field: s.field, descending: s.descending })
        .into_iter()
        .collect();
    let query = meta_store::Query { filter, sort, limit: parsed.limit, offset: parsed.offset };
    Ok(Listed { query, with_count: parsed.with_count })
}

fn filter(node: Node) -> Filter {
    match node {
        Node::And(all) => Filter::And(all.into_iter().map(filter).collect()),
        Node::Or(any) => Filter::Or(any.into_iter().map(filter).collect()),
        Node::Leaf { field, op, value } => {
            // The parser admits only the operators the store has.
            let op = Op::of(&op).unwrap_or(Op::Eq);
            Filter::Field { field, op, value }
        }
    }
}

/// What a route answers: its response, either way. A refusal found before the service is
/// called is the `Err`, so a route reads each part of its request with `?`.
pub type Reply = Result<Response, Response>;

/// A list page: the rows, or `{ rows, total }` when the count was asked for.
pub fn page<T: Serialize>(out: Result<Page<T>, ServiceError>, secret: &[&str]) -> Reply {
    Ok(match out {
        Ok(Page { rows, total: None }) => answer(StatusCode::OK, &rows, secret),
        Ok(Page { rows, total: Some(total) }) => match to_json(&rows, secret) {
            Ok(rows) => reply(StatusCode::OK, json!({ "rows": rows, "total": total })),
            Err(e) => internal(&e),
        },
        Err(e) => error(e),
    })
}

/// What an operation answered: `200` with it, less the credentials `secret` names.
pub fn ok<T: Serialize>(out: Result<T, ServiceError>, secret: &[&str]) -> Reply {
    send(StatusCode::OK, out, secret)
}

/// What a create answered: `201` with the row, less the credentials `secret` names.
pub fn created<T: Serialize>(out: Result<T, ServiceError>, secret: &[&str]) -> Reply {
    send(StatusCode::CREATED, out, secret)
}

fn send<T: Serialize>(status: StatusCode, out: Result<T, ServiceError>, secret: &[&str]) -> Reply {
    Ok(match out {
        Ok(v) => answer(status, &v, secret),
        Err(e) => error(e),
    })
}

/// `204` on success, whatever the operation answered.
pub fn no_content<T>(out: Result<T, ServiceError>) -> Reply {
    Ok(match out {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error(e),
    })
}

/// `value` as JSON, with no credential `secret` names on any row in it.
fn to_json<T: Serialize>(value: &T, secret: &[&str]) -> Result<Value, serde_json::Error> {
    let mut value = serde_json::to_value(value)?;
    if !secret.is_empty() {
        let strip = |row: &mut Value| {
            if let Value::Object(m) = row {
                for k in secret {
                    m.remove(*k);
                }
            }
        };
        match &mut value {
            Value::Array(rows) => rows.iter_mut().for_each(strip),
            row => strip(row),
        }
    }
    Ok(value)
}

fn answer<T: Serialize>(status: StatusCode, value: &T, secret: &[&str]) -> Response {
    match to_json(value, secret) {
        Ok(body) => reply(status, body),
        Err(e) => internal(&e),
    }
}

fn internal(e: &dyn std::fmt::Display) -> Response {
    // The full error is the server's: the body names no SQL, table or value.
    eprintln!("meta_http: internal error: {e}");
    refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

/// The response for a service error.
pub fn error(e: ServiceError) -> Response {
    let status = StatusCode::from_u16(e.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    match e {
        ServiceError::Validation(violations) => validation_failed(issues(&violations)),
        ServiceError::LimitTooLarge { max } => {
            reply(status, json!({ "error": "limit_too_large", "maxLimit": max }))
        }
        ServiceError::Refused { code, message } => {
            let mut body = json!({ "error": code });
            if let Some(m) = message {
                body["message"] = Value::from(m);
            }
            reply(status, body)
        }
        ServiceError::Store(StoreError::UnknownField { field, .. })
        | ServiceError::Store(StoreError::BadValue { field, .. }) => {
            let message = format!("'{field}' is not a value the store can hold");
            validation_failed(vec![issue("custom", &field, &message)])
        }
        ServiceError::Store(StoreError::Database(db)) => match constraint(&db) {
            Some((kind, status)) => {
                reply(status, json!({ "error": "constraint_violation", "constraint": kind }))
            }
            None => internal(&db),
        },
        ServiceError::Store(other) => internal(&other),
        other if status.is_server_error() => internal(&other),
        other => refuse(status, other.code()),
    }
}

/// The kind of constraint a database refused a write by, and its status: 409 for a conflict with
/// another row, 400 for the request's own value.
fn constraint(e: &sqlx::Error) -> Option<(&'static str, StatusCode)> {
    use sqlx::error::ErrorKind;
    let sqlx::Error::Database(db) = e else { return None };
    Some(match db.kind() {
        ErrorKind::UniqueViolation => ("unique", StatusCode::CONFLICT),
        ErrorKind::ForeignKeyViolation => ("foreign_key", StatusCode::CONFLICT),
        ErrorKind::NotNullViolation => ("not_null", StatusCode::BAD_REQUEST),
        ErrorKind::CheckViolation => ("check", StatusCode::BAD_REQUEST),
        _ => return None,
    })
}

/// `400 validation`, listing every issue.
fn validation_failed(issues: Vec<Value>) -> Response {
    reply(StatusCode::BAD_REQUEST, json!({ "error": "validation", "issues": issues }))
}

/// One issue: its code (Zod's name for the failure), the member's path and a sentence.
fn issue(code: &str, field: &str, message: &str) -> Value {
    json!({ "code": code, "path": path(field), "message": message })
}

/// `outer[0].inner` as `["outer", 0, "inner"]`.
fn path(field: &str) -> Value {
    let mut out = Vec::new();
    for part in field.split('.').filter(|p| !p.is_empty()) {
        let mut rest = part;
        if let Some(at) = rest.find('[') {
            out.push(Value::from(&rest[..at]));
            rest = &rest[at..];
            while let Some(close) = rest.find(']') {
                match rest[1..close].parse::<u64>() {
                    Ok(n) => out.push(Value::from(n)),
                    Err(_) => out.push(Value::from(&rest[1..close])),
                }
                rest = &rest[close + 1..];
            }
        } else {
            out.push(Value::from(rest));
        }
    }
    Value::Array(out)
}

/// The issues of the model's rules a value breaks, each by Zod's name for it.
pub fn issues(violations: &[Violation]) -> Vec<Value> {
    violations
        .iter()
        .map(|v| {
            let code = match v.rule {
                validation::RULE_LENGTH | validation::RULE_ARRAY | validation::RULE_NUMERIC => {
                    // The checks say which bound was broken: "at least" is the lower one.
                    if v.message.contains("at least") {
                        "too_small"
                    } else {
                        "too_big"
                    }
                }
                validation::RULE_REGEX | validation::RULE_FORMAT => "invalid_format",
                _ => "custom",
            };
            issue(code, &v.field, &v.message)
        })
        .collect()
}

/// A request body as JSON, or `400 invalid_json`.
fn json_body(bytes: &[u8]) -> Result<Value, Response> {
    serde_json::from_slice(bytes).map_err(|_| refuse(StatusCode::BAD_REQUEST, "invalid_json"))
}

/// The members of a body the route keeps: `400 invalid_json`, a `validation` 400 for a body that
/// is not an object, `400 unknown_fields` (sorted) for an undeclared key under `reject`; then
/// only the `keep` keys.
fn members(bytes: &[u8], spec: &BodySpec, keep: &[&str]) -> Result<Map<String, Value>, Response> {
    let Value::Object(mut body) = json_body(bytes)? else {
        let message = "the body must be a JSON object";
        return Err(validation_failed(vec![json!({
            "code": "invalid_type",
            "path": [],
            "message": message,
        })]));
    };
    if spec.reject_unknown {
        let mut unknown: Vec<&str> =
            body.keys().map(String::as_str).filter(|k| !spec.declared.contains(k)).collect();
        if !unknown.is_empty() {
            unknown.sort_unstable();
            let fields = json!({ "error": "unknown_fields", "fields": unknown });
            return Err(reply(StatusCode::BAD_REQUEST, fields));
        }
    }
    body.retain(|k, _| keep.contains(&k.as_str()));
    Ok(body)
}

fn bind<T: DeserializeOwned>(body: Map<String, Value>) -> Result<T, Vec<Value>> {
    serde_path_to_error::deserialize(Value::Object(body)).map_err(|e| {
        let field = e.path().to_string();
        let field = if field == "." { String::new() } else { field };
        let message = e.inner().to_string();
        let code = if message.starts_with("unknown variant") {
            "invalid_value"
        } else if message.starts_with("missing field") || message.starts_with("invalid type") {
            "invalid_type"
        } else {
            "custom"
        };
        let field = match message.strip_prefix("missing field `") {
            Some(rest) => rest.split('`').next().unwrap_or("").to_string(),
            None => field,
        };
        vec![issue(code, &field, &message)]
    })
}

fn missing(field: &str) -> Value {
    issue("invalid_type", field, &format!("'{field}' is required"))
}

/// A create body as `C`. A required key that is absent or null is an issue, listed together with
/// every rule a present member breaks (checked through the update body `P` and `check`, since a
/// body missing a required member is no `C` to check).
pub fn create_body<C, P>(
    bytes: &[u8],
    spec: &BodySpec,
    check: impl Fn(&P) -> Vec<Violation>,
) -> Result<C, Response>
where
    C: DeserializeOwned,
    P: DeserializeOwned,
{
    let body = members(bytes, spec, spec.create)?;
    let absent: Vec<&str> = spec
        .create_required
        .iter()
        .copied()
        .filter(|k| body.get(*k).is_none_or(Value::is_null))
        .collect();
    if absent.is_empty() {
        return bind(body).map_err(validation_failed);
    }
    let mut found: Vec<Value> = absent.iter().map(|k| missing(k)).collect();
    let mut present = body;
    present.retain(|k, v| !v.is_null() && spec.update.contains(&k.as_str()));
    if let Ok(partial) = bind::<P>(present) {
        found.extend(issues(&check(&partial)));
    }
    Err(validation_failed(found))
}

/// An update body as `P`. A null on a member that may not be null is an issue, listed together
/// with every rule a present member breaks.
pub fn update_body<P>(
    bytes: &[u8],
    spec: &BodySpec,
    check: impl Fn(&P) -> Vec<Violation>,
) -> Result<P, Response>
where
    P: DeserializeOwned,
{
    let mut body = members(bytes, spec, spec.update)?;
    let nulls: Vec<String> = body
        .iter()
        .filter(|(k, v)| v.is_null() && spec.update_not_null.contains(&k.as_str()))
        .map(|(k, _)| k.clone())
        .collect();
    if nulls.is_empty() {
        return bind(body).map_err(validation_failed);
    }
    let mut found: Vec<Value> = nulls.iter().map(|k| missing(k)).collect();
    body.retain(|k, _| !nulls.contains(k));
    if let Ok(partial) = bind::<P>(body) {
        found.extend(issues(&check(&partial)));
    }
    Err(validation_failed(found))
}

/// An operation's input as `I`, from a JSON body (an empty one is `{}`).
pub fn input_body<I: DeserializeOwned>(bytes: &[u8]) -> Result<I, Response> {
    let value = if bytes.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Map::new())
    } else {
        json_body(bytes)?
    };
    let Value::Object(body) = value else {
        return Err(validation_failed(vec![issue(
            "invalid_type",
            "",
            "the body must be an object",
        )]));
    };
    bind(body).map_err(validation_failed)
}
