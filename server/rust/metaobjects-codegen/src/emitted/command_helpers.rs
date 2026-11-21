//! What every generated command crate uses: the body a command line describes, the query
//! its filters describe, and the error a command fails with.

use std::fmt;
use std::io::Read;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// What a command returns: the server's answer as JSON (`null` when it sent none).
pub type Answer = Result<Value, Error>;

/// Why a command failed.
#[derive(Debug)]
pub enum Error {
    /// The command line asks for something the model does not allow, or is not well formed.
    Usage(String),
    /// The body breaks rules of the model: one message per rule. Nothing was sent.
    Invalid(Vec<String>),
    /// The call failed.
    Api(meta_client::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Usage(message) => f.write_str(message),
            Error::Invalid(messages) => write!(f, "the body is not valid: {}", messages.join("; ")),
            Error::Api(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Api(e) => Some(e),
            _ => None,
        }
    }
}

impl From<meta_client::Error> for Error {
    fn from(e: meta_client::Error) -> Self {
        Error::Api(e)
    }
}

/// The body a `--json` argument gives: a JSON object, read from standard input when the
/// argument is `-`, and empty when there is no argument.
pub fn body(json: Option<&str>) -> Result<Map<String, Value>, Error> {
    let text = match json {
        None => return Ok(Map::new()),
        Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|e| {
                Error::Usage(format!("cannot read the body from standard input: {e}"))
            })?;
            text
        }
        Some(text) => text.to_string(),
    };
    match serde_json::from_str(&text) {
        Ok(Value::Object(body)) => Ok(body),
        Ok(_) => Err(Error::Usage("the body must be a JSON object".to_string())),
        Err(e) => Err(Error::Usage(format!("the body is not JSON: {e}"))),
    }
}

/// Refuses a body member the model does not declare: a misspelled name must not be dropped
/// on the way to the server, which would refuse it too under its default setting.
pub fn known(body: &Map<String, Value>, members: &[&str]) -> Result<(), Error> {
    let unknown: Vec<&str> =
        body.keys().map(String::as_str).filter(|name| !members.contains(name)).collect();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(Error::Usage(format!(
        "the body sets {}, which the model does not declare (it declares: {})",
        unknown.join(", "),
        members.join(", ")
    )))
}

/// Sets one member of the body from its flag, when the flag was given.
pub fn put<T: Serialize>(
    body: &mut Map<String, Value>,
    name: &str,
    value: Option<T>,
) -> Result<(), Error> {
    if let Some(value) = value {
        let value = serde_json::to_value(value)
            .map_err(|e| Error::Usage(format!("the value of {name} cannot be sent: {e}")))?;
        body.insert(name.to_string(), value);
    }
    Ok(())
}

/// Sets one array member of the body from its repeated flag, when it was given at all.
pub fn put_all<T: Serialize>(
    body: &mut Map<String, Value>,
    name: &str,
    values: Vec<T>,
) -> Result<(), Error> {
    if values.is_empty() {
        return Ok(());
    }
    put(body, name, Some(values))
}

/// Reads the finished body as the model's type.
pub fn decode<T: DeserializeOwned>(body: Map<String, Value>) -> Result<T, Error> {
    serde_json::from_value(Value::Object(body))
        .map_err(|e| Error::Usage(format!("the body does not fit the model: {e}")))
}

/// Refuses a body that breaks rules of the model.
pub fn check(found: Vec<meta_support::validation::Violation>) -> Result<(), Error> {
    if found.is_empty() {
        return Ok(());
    }
    Err(Error::Invalid(found.into_iter().map(|v| v.message).collect()))
}

/// Adds the `--filter` tests to a query. A test is written `field:op=value`, and
/// `field=value` means `field:eq=value`. `allowed` is the model's allowlist.
pub fn filters(
    query: &mut meta_client::Query,
    tests: &[String],
    allowed: &[(&str, &[&str])],
) -> Result<(), Error> {
    for test in tests {
        let Some((subject, value)) = test.split_once('=') else {
            return Err(Error::Usage(format!("--filter {test}: expected field:op=value")));
        };
        let (field, op) = subject.split_once(':').unwrap_or((subject, "eq"));
        let Some((_, ops)) = allowed.iter().find(|(name, _)| *name == field) else {
            let names: Vec<&str> = allowed.iter().map(|(name, _)| *name).collect();
            return Err(Error::Usage(format!(
                "--filter {test}: {field} is not a field this list filters on (it filters on: {})",
                names.join(", ")
            )));
        };
        if !ops.contains(&op) {
            return Err(Error::Usage(format!(
                "--filter {test}: {field} does not take {op} (it takes: {})",
                ops.join(", ")
            )));
        }
        query.filter(field, op, value);
    }
    Ok(())
}

/// Adds the `--sort` to a query: `field`, `field:asc` or `field:desc`. `allowed` is the
/// model's allowlist.
pub fn sort(
    query: &mut meta_client::Query,
    spec: Option<&str>,
    allowed: &[&str],
) -> Result<(), Error> {
    let Some(spec) = spec else {
        return Ok(());
    };
    let (field, direction) = match spec.split_once(':') {
        None => (spec, meta_client::Direction::Default),
        Some((field, "asc")) => (field, meta_client::Direction::Ascending),
        Some((field, "desc")) => (field, meta_client::Direction::Descending),
        Some(_) => {
            return Err(Error::Usage(format!(
                "--sort {spec}: expected field, field:asc or field:desc"
            )));
        }
    };
    if !allowed.contains(&field) {
        return Err(Error::Usage(format!(
            "--sort {spec}: {field} is not a field this list sorts on (it sorts on: {})",
            allowed.join(", ")
        )));
    }
    query.sort(field, direction);
    Ok(())
}

/// Adds the `--limit` and the `--offset` to a query.
pub fn window(query: &mut meta_client::Query, limit: Option<u64>, offset: Option<u64>) {
    if let Some(limit) = limit {
        query.limit(limit);
    }
    if let Some(offset) = offset {
        query.offset(offset);
    }
}

/// What the server answered, as the JSON a command returns.
pub fn answer<T: Serialize>(found: &T) -> Answer {
    serde_json::to_value(found)
        .map_err(|e| Error::Usage(format!("the answer cannot be written as JSON: {e}")))
}

/// An answer as the text a command prints.
pub fn render(answer: &Value) -> String {
    serde_json::to_string_pretty(answer).unwrap_or_else(|_| answer.to_string())
}
