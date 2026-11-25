//! The transport every generated client crate uses: one HTTP client, the list query, and
//! the error a call fails with. It follows the REST contract every MetaObjects server
//! generator implements, whatever language the server is written in.

use std::fmt;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// The HTTP library underneath, so a caller can set a client up without naming it as a
/// dependency of its own.
pub use reqwest;

/// What a call returns.
pub type Result<T> = std::result::Result<T, Error>;

/// Why a call failed.
#[derive(Debug)]
pub enum Error {
    /// The request did not get an answer.
    Transport(reqwest::Error),
    /// The server refused the request. `code` and `message` are its error body's `error` and
    /// `message` members, when it sent them; `body` is the body as it arrived.
    Api { status: u16, code: Option<String>, message: Option<String>, body: String },
    /// The server answered, and the body is not what the model says a row looks like.
    Decode { status: u16, message: String },
}

impl Error {
    /// The HTTP status of the answer, when there was one.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Transport(e) => e.status().map(|s| s.as_u16()),
            Error::Api { status, .. } | Error::Decode { status, .. } => Some(*status),
        }
    }

    /// The server's error code (`not_found`, `validation`, ...), when it sent one.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Transport(e) => write!(f, "the request failed: {e}"),
            Error::Api { status, code, message, .. } => {
                write!(f, "the server answered {status}")?;
                if let Some(code) = code {
                    write!(f, " {code}")?;
                }
                if let Some(message) = message {
                    write!(f, ": {message}")?;
                }
                Ok(())
            }
            Error::Decode { status, message } => {
                write!(f, "the server answered {status} with a body that does not fit: {message}")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Transport(e) => Some(e),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Transport(e)
    }
}

/// The API's address and the HTTP client that reaches it.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    /// A client for the API at `base_url`: the server's address and the prefix its routes
    /// are mounted under, as in `https://example.com/api`.
    pub fn new(base_url: &str) -> Self {
        Self::with_http(reqwest::Client::new(), base_url)
    }

    /// The same, over an HTTP client you set up yourself (timeouts, headers, a proxy).
    pub fn with_http(http: reqwest::Client, base_url: &str) -> Self {
        Self { http, base: base_url.trim_end_matches('/').to_string() }
    }

    /// The address every path is taken under.
    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path)
    }

    /// `GET path`, read as `T`.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        read(self.http.get(self.url(path)).send().await?).await
    }

    /// `GET path?query`, read as `T`.
    pub async fn list<T: DeserializeOwned>(&self, path: &str, query: &Query) -> Result<T> {
        read(self.http.get(self.url(path)).query(query.pairs()).send().await?).await
    }

    /// `POST path` with a JSON body, read as `T`.
    pub async fn post<B, T>(&self, path: &str, body: &B) -> Result<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        read(self.http.post(self.url(path)).json(body).send().await?).await
    }

    /// `PATCH path` with a JSON body, read as `T`.
    pub async fn patch<B, T>(&self, path: &str, body: &B) -> Result<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        read(self.http.patch(self.url(path)).json(body).send().await?).await
    }

    /// `DELETE path`.
    pub async fn delete(&self, path: &str) -> Result<()> {
        let response = self.http.delete(self.url(path)).send().await?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(refusal(response).await)
    }
}

async fn read<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        return Err(refusal(response).await);
    }
    let text = response.text().await?;
    serde_json::from_str(&text)
        .map_err(|e| Error::Decode { status: status.as_u16(), message: e.to_string() })
}

async fn refusal(response: reqwest::Response) -> Error {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
    let member = |name: &str| {
        parsed.as_ref().and_then(|v| v.get(name)).and_then(|v| v.as_str()).map(str::to_string)
    };
    Error::Api { status, code: member("error"), message: member("message"), body }
}

/// The order a sort puts rows in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// The order the model declares for the field (ascending when it declares none).
    Default,
    Ascending,
    Descending,
}

/// The query of a list request: filters, a sort and a window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    pub fn new() -> Self {
        Self::default()
    }

    /// The query's parameters, in the order they were added, not yet percent-encoded.
    pub fn pairs(&self) -> &[(String, String)] {
        &self.pairs
    }

    fn set(&mut self, name: &str, value: String) {
        self.pairs.retain(|(n, _)| n != name);
        self.pairs.push((name.to_string(), value));
    }

    /// Keep the rows whose `field` passes `op` against `value`. Filters add up: a row must
    /// pass them all.
    pub fn filter(&mut self, field: &str, op: &str, value: impl fmt::Display) {
        self.pairs.push((format!("filter[{field}][{op}]"), value.to_string()));
    }

    /// Keep the rows whose `field` is one of `values`.
    pub fn filter_in<V: fmt::Display>(&mut self, field: &str, values: impl IntoIterator<Item = V>) {
        let joined: Vec<String> = values.into_iter().map(|v| v.to_string()).collect();
        self.filter(field, "in", joined.join(","));
    }

    /// Sort by `field`. A later sort replaces an earlier one: the contract has one sort key.
    pub fn sort(&mut self, field: &str, direction: Direction) {
        let value = match direction {
            Direction::Default => field.to_string(),
            Direction::Ascending => format!("{field}:asc"),
            Direction::Descending => format!("{field}:desc"),
        };
        self.set("sort", value);
    }

    /// Return at most `rows` rows.
    pub fn limit(&mut self, rows: u64) {
        self.set("limit", rows.to_string());
    }

    /// Skip the first `rows` rows.
    pub fn offset(&mut self, rows: u64) {
        self.set("offset", rows.to_string());
    }

    /// Ask for the `{ rows, total }` answer a [`Page`] reads.
    pub fn with_count(&mut self) {
        self.set("withCount", "1".to_string());
    }
}

/// One window of a list, and how many rows the filters match in all.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Page<T> {
    pub rows: Vec<T>,
    pub total: u64,
}

/// The path of one row: `collection/id`, with the id percent-encoded.
pub fn row(collection: &str, id: impl fmt::Display) -> String {
    format!("{collection}/{}", segment(&id.to_string()))
}

/// The path of the rows related to one row: `collection/id/relation`.
pub fn related(collection: &str, id: impl fmt::Display, relation: &str) -> String {
    format!("{}/{relation}", row(collection, id))
}

/// One path segment, percent-encoded: everything but RFC 3986's unreserved characters.
pub fn segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
