//! Where an error happened: the file and JSON path, in the shared envelope shape.

/// The location part of an error envelope.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ErrorSource {
    /// Raised by code with no document location (registry composition, say).
    #[default]
    Code,
    /// A location in one JSON document.
    Json {
        files: Vec<String>,
        json_path: String,
    },
    /// A reference that did not resolve: the referring node and the reference.
    Resolved {
        files: Vec<String>,
        json_path: String,
        referrer: String,
        target: String,
    },
}

impl ErrorSource {
    pub fn json(file: &str, json_path: impl Into<String>) -> Self {
        ErrorSource::Json {
            files: vec![file.to_string()],
            json_path: json_path.into(),
        }
    }

    /// The envelope's `format` value.
    pub fn format(&self) -> &'static str {
        match self {
            ErrorSource::Code => "code",
            ErrorSource::Json { .. } => "json",
            ErrorSource::Resolved { .. } => "resolved",
        }
    }

    pub fn files(&self) -> &[String] {
        match self {
            ErrorSource::Code => &[],
            ErrorSource::Json { files, .. } | ErrorSource::Resolved { files, .. } => files,
        }
    }

    pub fn json_path(&self) -> Option<&str> {
        match self {
            ErrorSource::Code => None,
            ErrorSource::Json { json_path, .. } | ErrorSource::Resolved { json_path, .. } => {
                Some(json_path)
            }
        }
    }

    /// Rewrite every file path with `f` (the conformance runner makes them relative).
    pub fn map_files(&mut self, f: impl Fn(&str) -> String) {
        if let ErrorSource::Json { files, .. } | ErrorSource::Resolved { files, .. } = self {
            for file in files.iter_mut() {
                *file = f(file);
            }
        }
    }
}

/// A JSON path built the way every port writes it: `$`, then `[i]` for an index,
/// `.key` for an identifier key and `['key']` for any other key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonPath(String);

impl Default for JsonPath {
    fn default() -> Self {
        JsonPath("$".to_string())
    }
}

impl JsonPath {
    pub fn root() -> Self {
        Self::default()
    }

    pub fn index(&self, i: usize) -> Self {
        JsonPath(format!("{}[{i}]", self.0))
    }

    pub fn key(&self, key: &str) -> Self {
        let mut chars = key.chars();
        let ident = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if ident {
            JsonPath(format!("{}.{key}", self.0))
        } else {
            JsonPath(format!("{}['{}']", self.0, key.replace('\'', "\\'")))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for JsonPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
