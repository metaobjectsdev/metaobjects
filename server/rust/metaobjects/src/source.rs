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
    /// A location in one YAML document: the same path, plus the line and column of
    /// the node's key when the parse knows them.
    Yaml {
        files: Vec<String>,
        json_path: String,
        position: Option<YamlPosition>,
    },
    /// A node several files contributed to: every contributing file, sorted.
    Merged {
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

/// A 1-indexed line and column in a YAML document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YamlPosition {
    pub line: u32,
    pub col: u32,
}

impl ErrorSource {
    pub fn yaml(file: &str, json_path: impl Into<String>, position: Option<YamlPosition>) -> Self {
        ErrorSource::Yaml {
            files: vec![file.to_string()],
            json_path: json_path.into(),
            position,
        }
    }

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
            ErrorSource::Yaml { .. } => "yaml",
            ErrorSource::Resolved { .. } => "resolved",
            ErrorSource::Merged { .. } => "merged",
        }
    }

    pub fn files(&self) -> &[String] {
        match self {
            ErrorSource::Code => &[],
            ErrorSource::Json { files, .. }
            | ErrorSource::Yaml { files, .. }
            | ErrorSource::Merged { files, .. }
            | ErrorSource::Resolved { files, .. } => files,
        }
    }

    pub fn json_path(&self) -> Option<&str> {
        match self {
            ErrorSource::Code => None,
            ErrorSource::Json { json_path, .. }
            | ErrorSource::Yaml { json_path, .. }
            | ErrorSource::Merged { json_path, .. }
            | ErrorSource::Resolved { json_path, .. } => Some(json_path),
        }
    }

    /// The YAML position, when this envelope has one.
    pub fn yaml_position(&self) -> Option<YamlPosition> {
        match self {
            ErrorSource::Yaml { position, .. } => *position,
            _ => None,
        }
    }

    /// Rewrite every file path with `f` (the conformance runner makes them relative).
    pub fn map_files(&mut self, f: impl Fn(&str) -> String) {
        if let ErrorSource::Json { files, .. }
        | ErrorSource::Yaml { files, .. }
        | ErrorSource::Merged { files, .. }
        | ErrorSource::Resolved { files, .. } = self
        {
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
