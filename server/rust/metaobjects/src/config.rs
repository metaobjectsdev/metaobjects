//! The reader for `.metaobjects/config.json`, ported from the TypeScript SDK's
//! `config.ts` (a zod schema there, hand-written validation over
//! `serde_json::Value` here).
//!
//! Strictness follows the TypeScript reader. A key this version does not know at
//! the TOP level is a warning returned as data (a newer MetaObjects may have
//! written it); a wrong type on a known key, and an unknown key inside a block
//! the reader owns, is an error that names the file and each problem. The two
//! blocks TypeScript leaves non-strict (`confidence_thresholds`, `extract`)
//! ignore unknown keys here too.

use std::path::Path;

use serde_json::{Map, Value};

use crate::errors::{ERR_BAD_ATTR_VALUE, ERR_MALFORMED_JSON, ERR_UNKNOWN, MetaError};
use crate::naming::{NamingKind, NamingRegistry, PhysicalNaming};
use crate::sources::{CONFIG_FILE, SourceSpec};

/// The only `schema_version` this reader accepts.
pub const SCHEMA_VERSION: u64 = 1;
/// The largest page size every port's integer type holds.
pub const PAGE_SIZE_MAX: u64 = 2_147_483_647;
/// The largest integer a JSON number can carry exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The top-level keys this version reads.
pub const CONFIG_TOP_LEVEL_KEYS: &[&str] = &[
    "schema_version",
    "pending_in_git",
    "confidence_thresholds",
    "sources",
    "dependencies",
    "libraries",
    "scope",
    "extract",
    "migrate",
    "verify",
    "requirements",
    "naming",
    "wire",
    "api",
    "enums",
    "csharp",
];

/// The `migrate.allow` tokens (kept in step with the CLI's `ALLOW_TOKENS`).
pub const ALLOW_TOKENS: &[&str] = &[
    "drop-column",
    "drop-table",
    "type-change",
    "drop-index",
    "drop-fk",
    "drop-check",
    "drop-view",
    "drop-view-cascade",
    "drop-column-read-by-view",
    "adopt-view",
    "nullable-to-not-null",
    "drop-identity-default",
    "drop-unmanaged",
    "drop-comment",
];
const MIGRATE_DIALECTS: &[&str] = &["sqlite", "postgres", "d1"];
const MIGRATE_FORMATS: &[&str] = &["default", "flyway"];
const MIGRATE_ON_AMBIGUOUS: &[&str] = &["abort", "rename", "drop-add"];

macro_rules! string_enum {
    ($(#[$m:meta])* $name:ident { $($var:ident => $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name { $($var),+ }
        impl $name {
            /// Every accepted spelling, in declaration order.
            pub const ALL: &'static [&'static str] = &[$($s),+];
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some(Self::$var),)+ _ => None }
            }
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$var => $s),+ }
            }
        }
    };
}

string_enum!(
    /// `wire.decimals`.
    WireDecimals { Native => "native", String => "string" }
);
string_enum!(
    /// `wire.nullMembers`.
    WireNullMembers { Native => "native", Emit => "emit", Omit => "omit" }
);
string_enum!(
    /// `wire.durations`.
    WireDurations { Native => "native", Iso => "iso" }
);
string_enum!(
    /// `api.unknownFields`.
    UnknownFieldsMode { Reject => "reject", Drop => "drop" }
);
string_enum!(
    /// `verify.handEdits`.
    HandEditsPolicy { Fail => "fail", Notice => "notice" }
);

/// The output form of a generated REST surface, each absent key at its default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireFormat {
    pub decimals: WireDecimals,
    pub null_members: WireNullMembers,
    pub durations: WireDurations,
}

impl Default for WireFormat {
    fn default() -> Self {
        Self {
            decimals: WireDecimals::Native,
            null_members: WireNullMembers::Native,
            durations: WireDurations::Native,
        }
    }
}

/// The `wire` block as written; absent keys are `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WireConfig {
    pub decimals: Option<WireDecimals>,
    pub null_members: Option<WireNullMembers>,
    pub durations: Option<WireDurations>,
}

/// The page size of generated list routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiPagination {
    pub default_limit: u32,
    pub max_limit: u32,
}

/// The `api` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApiConfig {
    pub pagination: Option<ApiPagination>,
    pub unknown_fields: Option<UnknownFieldsMode>,
}

/// The string-stored enum defaults (`enums`); none when absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EnumDefaults {
    pub max_length: Option<u64>,
}

/// The `naming` block as written.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NamingConfig {
    pub columns: Option<String>,
    pub tables: Option<String>,
    pub collections: Option<String>,
}

/// An output filter: include and exclude package patterns. Parsed and validated
/// only; matching is not part of this module.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Scope {
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

/// `confidence_thresholds`, defaults applied.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConfidenceThresholds {
    pub pending_promote: f64,
    pub drift_warn: f64,
}

impl Default for ConfidenceThresholds {
    fn default() -> Self {
        Self {
            pending_promote: 0.8,
            drift_warn: 0.7,
        }
    }
}

/// `migrate.d1`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct D1Block {
    pub binding: Option<String>,
    pub remote: Option<bool>,
    pub auto_apply: Option<bool>,
    pub wrangler_config_path: Option<String>,
}

/// The `migrate` block: every key optional, every unknown key an error.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MigrateConfig {
    pub out_dir: Option<String>,
    pub database_url: Option<String>,
    pub shadow_database_url: Option<String>,
    pub dialect: Option<String>,
    pub format: Option<String>,
    pub on_ambiguous: Option<String>,
    pub allow: Option<Vec<String>>,
    pub d1: Option<D1Block>,
    pub scope: Option<Vec<String>>,
    pub conventions: Option<String>,
    /// `migrate.checks.skipRedundant`.
    pub checks_skip_redundant: Option<bool>,
    /// `migrate.checks` was present (possibly empty).
    pub checks_present: bool,
    pub foreign_key_indexes: Option<bool>,
}

/// One declared metadata dependency (FR-023). Parsed and validated only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencySpec {
    pub name: String,
    pub transport: DependencyTransport,
}

/// The one transport a dependency names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyTransport {
    Path(String),
    Npm {
        npm: String,
        dir: Option<String>,
    },
    Python {
        python: String,
        dir: Option<String>,
    },
    Maven {
        maven: String,
        version: String,
        dir: Option<String>,
    },
    Nuget {
        nuget: String,
        version: String,
        dir: Option<String>,
    },
}

/// A C# metadata provider: a built assembly and the provider's full type name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsharpProvider {
    pub assembly: String,
    pub type_name: String,
}

/// The `csharp` block.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CsharpConfig {
    pub out_dir: Option<String>,
    pub namespace: Option<String>,
    pub providers: Option<Vec<CsharpProvider>>,
}

/// A parsed `.metaobjects/config.json`, defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub schema_version: u64,
    pub pending_in_git: bool,
    pub confidence_thresholds: ConfidenceThresholds,
    pub sources: Vec<SourceSpec>,
    pub dependencies: Vec<DependencySpec>,
    pub libraries: Vec<String>,
    pub scope: Option<Scope>,
    /// `extract.metaignore`.
    pub extract_metaignore: Option<String>,
    pub migrate: Option<MigrateConfig>,
    /// `verify.handEdits`; `None` when the block or the key is absent.
    pub hand_edits: Option<HandEditsPolicy>,
    /// `requirements.inherit`.
    pub requirements_inherit: Option<Vec<String>>,
    pub naming: Option<NamingConfig>,
    pub wire: Option<WireConfig>,
    pub api: Option<ApiConfig>,
    pub enums: Option<EnumDefaults>,
    pub csharp: Option<CsharpConfig>,
}

impl Default for Config {
    /// What `{ "schema_version": 1 }` parses to.
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            pending_in_git: true,
            confidence_thresholds: ConfidenceThresholds::default(),
            sources: Vec::new(),
            dependencies: Vec::new(),
            libraries: Vec::new(),
            scope: None,
            extract_metaignore: None,
            migrate: None,
            hand_edits: None,
            requirements_inherit: None,
            naming: None,
            wire: None,
            api: None,
            enums: None,
            csharp: None,
        }
    }
}

impl Config {
    /// The physical-naming rules, each absent rule at its default.
    pub fn physical_naming(&self) -> PhysicalNaming {
        let d = PhysicalNaming::default();
        let n = self.naming.clone().unwrap_or_default();
        PhysicalNaming {
            columns: n.columns.unwrap_or(d.columns),
            tables: n.tables.unwrap_or(d.tables),
            collections: n.collections,
        }
    }

    /// The wire format, each absent key at its default.
    pub fn wire_format(&self) -> WireFormat {
        let d = WireFormat::default();
        let w = self.wire.unwrap_or_default();
        WireFormat {
            decimals: w.decimals.unwrap_or(d.decimals),
            null_members: w.null_members.unwrap_or(d.null_members),
            durations: w.durations.unwrap_or(d.durations),
        }
    }

    /// The enum storage defaults; none when absent.
    pub fn enum_defaults(&self) -> EnumDefaults {
        self.enums.unwrap_or_default()
    }

    /// `api.pagination`; `None` when absent.
    pub fn api_pagination(&self) -> Option<ApiPagination> {
        self.api.and_then(|a| a.pagination)
    }

    /// `api.unknownFields`; `None` when absent (the default, `reject`).
    pub fn api_unknown_fields(&self) -> Option<UnknownFieldsMode> {
        self.api.and_then(|a| a.unknown_fields)
    }
}

/// A parsed config and the warnings reading it produced.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedConfig {
    pub config: Config,
    /// One message per unknown top-level key; nothing is printed.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Validation helpers

#[derive(Default)]
struct Issues(Vec<(String, String)>);

impl Issues {
    fn add(&mut self, at: &str, message: impl Into<String>) {
        self.0.push((at.to_string(), message.into()));
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expected(want: &str, v: &Value) -> String {
    format!("Invalid input: expected {want}, received {}", type_name(v))
}

/// A strict object: `Some` when `v` is an object, with each unknown key reported.
fn strict_object<'a>(
    v: &'a Value,
    at: &str,
    allowed: &[&str],
    issues: &mut Issues,
) -> Option<&'a Map<String, Value>> {
    let Some(o) = v.as_object() else {
        issues.add(at, expected("object", v));
        return None;
    };
    let unknown: Vec<String> = o
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .map(|k| format!("\"{k}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.add(at, format!("Unrecognized key: {}", unknown[0])),
        _ => issues.add(at, format!("Unrecognized keys: {}", unknown.join(", "))),
    }
    Some(o)
}

fn string_of(v: &Value, at: &str, issues: &mut Issues) -> Option<String> {
    match v.as_str() {
        Some(s) => Some(s.to_string()),
        None => {
            issues.add(at, expected("string", v));
            None
        }
    }
}

fn nonempty_string_of(v: &Value, at: &str, issues: &mut Issues) -> Option<String> {
    let s = string_of(v, at, issues)?;
    if s.is_empty() {
        issues.add(at, "Too small: expected string to have >=1 characters");
        return None;
    }
    Some(s)
}

fn bool_of(v: &Value, at: &str, issues: &mut Issues) -> Option<bool> {
    match v.as_bool() {
        Some(b) => Some(b),
        None => {
            issues.add(at, expected("boolean", v));
            None
        }
    }
}

fn array_of<'a>(v: &'a Value, at: &str, issues: &mut Issues) -> Option<&'a Vec<Value>> {
    match v.as_array() {
        Some(a) => Some(a),
        None => {
            issues.add(at, expected("array", v));
            None
        }
    }
}

fn string_array(v: &Value, at: &str, nonempty: bool, issues: &mut Issues) -> Option<Vec<String>> {
    let arr = array_of(v, at, issues)?;
    let mut out = Vec::with_capacity(arr.len());
    let mut ok = true;
    for (i, item) in arr.iter().enumerate() {
        let item_at = format!("{at}[{i}]");
        let s = if nonempty {
            nonempty_string_of(item, &item_at, issues)
        } else {
            string_of(item, &item_at, issues)
        };
        match s {
            Some(s) => out.push(s),
            None => ok = false,
        }
    }
    ok.then_some(out)
}

fn enum_of(
    v: &Value,
    at: &str,
    options: &[&str],
    message: Option<String>,
    issues: &mut Issues,
) -> Option<String> {
    let default_message = || {
        let list: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
        if v.is_string() {
            format!("Invalid option: expected one of {}", list.join("|"))
        } else {
            expected("string", v)
        }
    };
    match v.as_str() {
        Some(s) if options.contains(&s) => Some(s.to_string()),
        _ => {
            issues.add(at, message.unwrap_or_else(default_message));
            None
        }
    }
}

/// A JSON number that is a whole number, however it is spelled (`50`, `50.0`, `5e1`).
fn whole_number(v: &Value) -> Option<f64> {
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER).then_some(f)
}

fn page_size(v: Option<&Value>, key: &str, issues: &mut Issues) -> Option<u32> {
    let at = format!("api.pagination.{key}");
    let message = format!("\"api.pagination.{key}\" must be a positive integer");
    let Some(v) = v else {
        issues.add(&at, message);
        return None;
    };
    match whole_number(v) {
        Some(f) if f >= 1.0 && f <= PAGE_SIZE_MAX as f64 => Some(f as u32),
        _ => {
            issues.add(&at, message);
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Blocks

fn parse_sources(v: &Value, issues: &mut Issues) -> Vec<SourceSpec> {
    let Some(arr) = array_of(v, "sources", issues) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        let at = format!("sources[{i}]");
        let Some(o) = entry.as_object() else {
            issues.add(&at, expected("object", entry));
            continue;
        };
        let spec = (o.len() == 1)
            .then(|| o.iter().next())
            .flatten()
            .and_then(|(k, v)| {
                let s = v.as_str().filter(|s| !s.is_empty())?.to_string();
                match k.as_str() {
                    "path" => Some(SourceSpec::Path(s)),
                    "resource" => Some(SourceSpec::Resource(s)),
                    "package" => Some(SourceSpec::Package(s)),
                    _ => None,
                }
            });
        match spec {
            Some(s) => out.push(s),
            None => issues.add(
                &at,
                "expected exactly one of \"path\", \"resource\" or \"package\", set to a non-empty string",
            ),
        }
    }
    out
}

fn dependency_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
}

fn parse_dependencies(v: &Value, issues: &mut Issues) -> Vec<DependencySpec> {
    const TRANSPORTS: &[&str] = &["path", "npm", "python", "maven", "nuget"];
    let Some(arr) = array_of(v, "dependencies", issues) else {
        return Vec::new();
    };
    let mut out: Vec<DependencySpec> = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        let at = format!("dependencies[{i}]");
        let Some(o) = entry.as_object() else {
            issues.add(&at, expected("object", entry));
            continue;
        };
        let present: Vec<&str> = TRANSPORTS
            .iter()
            .copied()
            .filter(|t| o.contains_key(*t))
            .collect();
        if present.len() != 1 {
            issues.add(
                &at,
                "expected exactly one transport: \"path\", \"npm\", \"python\", \"maven\" or \"nuget\"",
            );
            continue;
        }
        let transport = present[0];
        let mut allowed = vec!["name", transport];
        if transport != "path" {
            allowed.push("dir");
        }
        if matches!(transport, "maven" | "nuget") {
            allowed.push("version");
        }
        let before = issues.0.len();
        let unknown: Vec<String> = o
            .keys()
            .filter(|k| !allowed.contains(&k.as_str()))
            .map(|k| format!("\"{k}\""))
            .collect();
        if !unknown.is_empty() {
            issues.add(&at, format!("Unrecognized key: {}", unknown.join(", ")));
        }
        let name = match o.get("name") {
            Some(n) => string_of(n, &format!("{at}.name"), issues).filter(|n| {
                let ok = dependency_name_ok(n);
                if !ok {
                    issues.add(
                        &format!("{at}.name"),
                        "Invalid string: must match pattern /^[a-z0-9][a-z0-9._-]*$/",
                    );
                }
                ok
            }),
            None => {
                issues.add(&format!("{at}.name"), expected("string", &Value::Null));
                None
            }
        };
        let main = o
            .get(transport)
            .and_then(|v| nonempty_string_of(v, &format!("{at}.{transport}"), issues));
        let dir = o
            .get("dir")
            .and_then(|v| nonempty_string_of(v, &format!("{at}.dir"), issues));
        let version = match o.get("version") {
            Some(v) => nonempty_string_of(v, &format!("{at}.version"), issues),
            None if matches!(transport, "maven" | "nuget") => {
                issues.add(&format!("{at}.version"), expected("string", &Value::Null));
                None
            }
            None => None,
        };
        if issues.0.len() > before {
            continue;
        }
        let (Some(name), Some(main)) = (name, main) else {
            continue;
        };
        let transport = match transport {
            "path" => DependencyTransport::Path(main),
            "npm" => DependencyTransport::Npm { npm: main, dir },
            "python" => DependencyTransport::Python { python: main, dir },
            "maven" => DependencyTransport::Maven {
                maven: main,
                version: version.unwrap_or_default(),
                dir,
            },
            _ => DependencyTransport::Nuget {
                nuget: main,
                version: version.unwrap_or_default(),
                dir,
            },
        };
        out.push(DependencySpec { name, transport });
    }
    let mut names: Vec<&str> = out.iter().map(|d| d.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    if names.len() != out.len() {
        issues.add("dependencies", "dependencies: names must be unique");
    }
    out
}

fn parse_scope(v: &Value, issues: &mut Issues) -> Option<Scope> {
    let o = strict_object(v, "scope", &["include", "exclude"], issues)?;
    Some(Scope {
        include: o
            .get("include")
            .and_then(|v| string_array(v, "scope.include", true, issues)),
        exclude: o
            .get("exclude")
            .and_then(|v| string_array(v, "scope.exclude", true, issues)),
    })
}

fn parse_migrate(v: &Value, issues: &mut Issues) -> Option<MigrateConfig> {
    const KEYS: &[&str] = &[
        "outDir",
        "databaseUrl",
        "shadowDatabaseUrl",
        "dialect",
        "format",
        "onAmbiguous",
        "allow",
        "d1",
        "scope",
        "conventions",
        "checks",
        "foreignKeyIndexes",
    ];
    let o = strict_object(v, "migrate", KEYS, issues)?;
    let s = |key: &str, issues: &mut Issues| {
        o.get(key)
            .and_then(|v| string_of(v, &format!("migrate.{key}"), issues))
    };
    let mut m = MigrateConfig {
        out_dir: s("outDir", issues),
        database_url: s("databaseUrl", issues),
        shadow_database_url: s("shadowDatabaseUrl", issues),
        ..MigrateConfig::default()
    };
    m.dialect = o
        .get("dialect")
        .and_then(|v| enum_of(v, "migrate.dialect", MIGRATE_DIALECTS, None, issues));
    m.format = o
        .get("format")
        .and_then(|v| enum_of(v, "migrate.format", MIGRATE_FORMATS, None, issues));
    m.on_ambiguous = o
        .get("onAmbiguous")
        .and_then(|v| enum_of(v, "migrate.onAmbiguous", MIGRATE_ON_AMBIGUOUS, None, issues));
    if let Some(v) = o.get("allow")
        && let Some(arr) = array_of(v, "migrate.allow", issues)
    {
        let mut tokens = Vec::new();
        for (i, t) in arr.iter().enumerate() {
            if let Some(t) = enum_of(
                t,
                &format!("migrate.allow[{i}]"),
                ALLOW_TOKENS,
                None,
                issues,
            ) {
                tokens.push(t);
            }
        }
        m.allow = Some(tokens);
    }
    if let Some(v) = o.get("d1")
        && let Some(d) = strict_object(
            v,
            "migrate.d1",
            &["binding", "remote", "autoApply", "wranglerConfigPath"],
            issues,
        )
    {
        m.d1 = Some(D1Block {
            binding: d
                .get("binding")
                .and_then(|v| string_of(v, "migrate.d1.binding", issues)),
            remote: d
                .get("remote")
                .and_then(|v| bool_of(v, "migrate.d1.remote", issues)),
            auto_apply: d
                .get("autoApply")
                .and_then(|v| bool_of(v, "migrate.d1.autoApply", issues)),
            wrangler_config_path: d
                .get("wranglerConfigPath")
                .and_then(|v| string_of(v, "migrate.d1.wranglerConfigPath", issues)),
        });
    }
    m.scope = o
        .get("scope")
        .and_then(|v| string_array(v, "migrate.scope", true, issues));
    m.conventions = o
        .get("conventions")
        .and_then(|v| nonempty_string_of(v, "migrate.conventions", issues));
    if let Some(v) = o.get("checks")
        && let Some(c) = strict_object(v, "migrate.checks", &["skipRedundant"], issues)
    {
        m.checks_present = true;
        m.checks_skip_redundant = c
            .get("skipRedundant")
            .and_then(|v| bool_of(v, "migrate.checks.skipRedundant", issues));
    }
    m.foreign_key_indexes = o
        .get("foreignKeyIndexes")
        .and_then(|v| bool_of(v, "migrate.foreignKeyIndexes", issues));
    Some(m)
}

fn parse_naming(v: &Value, naming: &NamingRegistry, issues: &mut Issues) -> Option<NamingConfig> {
    let o = strict_object(v, "naming", &["columns", "tables", "collections"], issues)?;
    let mut pick = |key: &str,
                    kind: NamingKind,
                    known: &dyn Fn(&NamingRegistry, &str) -> bool|
     -> Option<String> {
        let at = format!("naming.{key}");
        let s = string_of(o.get(key)?, &at, issues)?;
        if known(naming, &s) {
            Some(s)
        } else {
            issues.add(&at, naming.unknown_strategy_message(kind, &s));
            None
        }
    };
    Some(NamingConfig {
        columns: pick("columns", NamingKind::Columns, &|r, n| {
            r.has_column_strategy(n)
        }),
        tables: pick("tables", NamingKind::Tables, &|r, n| r.has_table_rule(n)),
        collections: pick("collections", NamingKind::Collections, &|r, n| {
            r.has_pluralizer(n)
        }),
    })
}

fn parse_wire(v: &Value, issues: &mut Issues) -> Option<WireConfig> {
    let Some(o) = v.as_object() else {
        issues.add("wire", "\"wire\" must be an object");
        return None;
    };
    if let Some(k) = o
        .keys()
        .find(|k| !["decimals", "nullMembers", "durations"].contains(&k.as_str()))
    {
        issues.add(
            "wire",
            format!(
                "\"wire\" has an unknown key \"{k}\" (expected \"decimals\", \"nullMembers\" and/or \"durations\")"
            ),
        );
    }
    let mut pick = |key: &str, all: &[&str]| -> Option<String> {
        let list: Vec<String> = all.iter().map(|v| format!("\"{v}\"")).collect();
        let message = format!("\"wire.{key}\" must be one of {}", list.join(", "));
        enum_of(
            o.get(key)?,
            &format!("wire.{key}"),
            all,
            Some(message),
            issues,
        )
    };
    Some(WireConfig {
        decimals: pick("decimals", WireDecimals::ALL).and_then(|s| WireDecimals::parse(&s)),
        null_members: pick("nullMembers", WireNullMembers::ALL)
            .and_then(|s| WireNullMembers::parse(&s)),
        durations: pick("durations", WireDurations::ALL).and_then(|s| WireDurations::parse(&s)),
    })
}

fn parse_api(v: &Value, issues: &mut Issues) -> Option<ApiConfig> {
    let Some(o) = v.as_object() else {
        issues.add("api", "\"api\" must be an object");
        return None;
    };
    if let Some(k) = o
        .keys()
        .find(|k| !["pagination", "unknownFields"].contains(&k.as_str()))
    {
        issues.add(
            "api",
            format!(
                "\"api\" has an unknown key \"{k}\" (expected \"pagination\" or \"unknownFields\")"
            ),
        );
    }
    let mut cfg = ApiConfig::default();
    if let Some(p) = o.get("pagination") {
        match p.as_object() {
            None => issues.add("api.pagination", "\"api.pagination\" must be an object"),
            Some(po) => {
                if let Some(k) = po
                    .keys()
                    .find(|k| !["defaultLimit", "maxLimit"].contains(&k.as_str()))
                {
                    issues.add(
                        "api.pagination",
                        format!(
                            "\"api.pagination\" has an unknown key \"{k}\" (expected \"defaultLimit\" and \"maxLimit\")"
                        ),
                    );
                }
                let d = page_size(po.get("defaultLimit"), "defaultLimit", issues);
                let m = page_size(po.get("maxLimit"), "maxLimit", issues);
                if let (Some(default_limit), Some(max_limit)) = (d, m) {
                    if default_limit > max_limit {
                        issues.add(
                            "api.pagination",
                            "\"api.pagination.defaultLimit\" must not exceed \"api.pagination.maxLimit\"",
                        );
                    } else {
                        cfg.pagination = Some(ApiPagination {
                            default_limit,
                            max_limit,
                        });
                    }
                }
            }
        }
    }
    if let Some(u) = o.get("unknownFields") {
        let message = "\"api.unknownFields\" must be \"reject\" or \"drop\"".to_string();
        cfg.unknown_fields = enum_of(
            u,
            "api.unknownFields",
            UnknownFieldsMode::ALL,
            Some(message),
            issues,
        )
        .and_then(|s| UnknownFieldsMode::parse(&s));
    }
    Some(cfg)
}

fn parse_enums(v: &Value, issues: &mut Issues) -> Option<EnumDefaults> {
    let o = strict_object(v, "enums", &["maxLength"], issues)?;
    let mut out = EnumDefaults::default();
    if let Some(m) = o.get("maxLength") {
        let at = "enums.maxLength";
        if !m.is_number() {
            issues.add(at, expected("number", m));
        } else {
            match whole_number(m) {
                None => issues.add(at, "Invalid input: expected int, received number"),
                Some(f) if f <= 0.0 => {
                    issues.add(at, "Too small: expected number to be >0");
                }
                Some(f) => out.max_length = Some(f as u64),
            }
        }
    }
    Some(out)
}

fn parse_csharp(v: &Value, issues: &mut Issues) -> Option<CsharpConfig> {
    let o = strict_object(v, "csharp", &["outDir", "namespace", "providers"], issues)?;
    let mut out = CsharpConfig {
        out_dir: o
            .get("outDir")
            .and_then(|v| nonempty_string_of(v, "csharp.outDir", issues)),
        namespace: o
            .get("namespace")
            .and_then(|v| nonempty_string_of(v, "csharp.namespace", issues)),
        providers: None,
    };
    if let Some(p) = o.get("providers")
        && let Some(arr) = array_of(p, "csharp.providers", issues)
    {
        let mut providers = Vec::new();
        for (i, item) in arr.iter().enumerate() {
            let at = format!("csharp.providers[{i}]");
            let Some(po) = strict_object(item, &at, &["assembly", "type"], issues) else {
                continue;
            };
            let field = |key: &str, issues: &mut Issues| match po.get(key) {
                Some(v) => nonempty_string_of(v, &format!("{at}.{key}"), issues),
                None => {
                    issues.add(&format!("{at}.{key}"), expected("string", &Value::Null));
                    None
                }
            };
            if let (Some(assembly), Some(type_name)) =
                (field("assembly", issues), field("type", issues))
            {
                providers.push(CsharpProvider {
                    assembly,
                    type_name,
                });
            }
        }
        out.providers = Some(providers);
    }
    Some(out)
}

fn unit_number(v: &Value, at: &str, default: f64, issues: &mut Issues) -> f64 {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f < 0.0 {
                issues.add(at, "Too small: expected number to be >=0");
            } else if f > 1.0 {
                issues.add(at, "Too big: expected number to be <=1");
            }
            f
        }
        other => {
            issues.add(at, expected("number", other));
            default
        }
    }
}

fn parse_thresholds(v: &Value, issues: &mut Issues) -> ConfidenceThresholds {
    let mut t = ConfidenceThresholds::default();
    let Some(o) = v.as_object() else {
        issues.add("confidence_thresholds", expected("object", v));
        return t;
    };
    if let Some(p) = o.get("pending_promote") {
        t.pending_promote = unit_number(p, "confidence_thresholds.pending_promote", 0.8, issues);
    }
    if let Some(d) = o.get("drift_warn") {
        t.drift_warn = unit_number(d, "confidence_thresholds.drift_warn", 0.7, issues);
    }
    t
}

// ---------------------------------------------------------------------------
// Public entry points

fn describe_config_error(path: &str, issues: &Issues) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (at, message) in &issues.0 {
        let at = if at.is_empty() { "(top level)" } else { at };
        let line = format!("  {at}: {message}");
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    let touches_sources = issues
        .0
        .iter()
        .any(|(at, _)| at == "sources" || at.starts_with("sources["));
    let mut out = format!(
        "{path} is not a valid MetaObjects config:\n{}",
        lines.join("\n")
    );
    if touches_sources {
        out.push_str(
            "\nEach `sources` entry is an object, for example { \"path\": \"model\" }, never a bare string.",
        );
    }
    out
}

/// Validate a parsed config document. `display_path` names the file in messages.
///
/// Forward-tolerant at the top level: an unknown key becomes one warning and is
/// ignored. Everything this version knows is validated strictly.
pub fn parse_config(
    doc: &Value,
    display_path: &str,
    naming: &NamingRegistry,
) -> Result<LoadedConfig, MetaError> {
    let mut issues = Issues::default();
    let mut warnings = Vec::new();
    let mut cfg = Config::default();
    match doc.as_object() {
        None => issues.add("", expected("object", doc)),
        Some(o) => {
            for key in o.keys() {
                if !CONFIG_TOP_LEVEL_KEYS.contains(&key.as_str()) {
                    warnings.push(format!(
                        "warning: {display_path}: unknown top-level key \"{key}\" ignored. A newer MetaObjects may have written it; upgrade this tool, or remove the key if it is a misspelling. Known keys: {}.",
                        CONFIG_TOP_LEVEL_KEYS.join(", ")
                    ));
                }
            }
            match o.get("schema_version") {
                Some(v) if whole_number(v) == Some(SCHEMA_VERSION as f64) => {}
                _ => issues.add("schema_version", "Invalid input: expected 1"),
            }
            if let Some(v) = o.get("pending_in_git")
                && let Some(b) = bool_of(v, "pending_in_git", &mut issues)
            {
                cfg.pending_in_git = b;
            }
            if let Some(v) = o.get("confidence_thresholds") {
                cfg.confidence_thresholds = parse_thresholds(v, &mut issues);
            }
            if let Some(v) = o.get("sources") {
                cfg.sources = parse_sources(v, &mut issues);
            }
            if let Some(v) = o.get("dependencies") {
                cfg.dependencies = parse_dependencies(v, &mut issues);
            }
            if let Some(v) = o.get("libraries")
                && let Some(l) = string_array(v, "libraries", false, &mut issues)
            {
                cfg.libraries = l;
            }
            if let Some(v) = o.get("scope") {
                cfg.scope = parse_scope(v, &mut issues);
            }
            if let Some(v) = o.get("extract") {
                match v.as_object() {
                    None => issues.add("extract", expected("object", v)),
                    Some(eo) => {
                        cfg.extract_metaignore = eo
                            .get("metaignore")
                            .and_then(|v| string_of(v, "extract.metaignore", &mut issues));
                    }
                }
            }
            if let Some(v) = o.get("migrate") {
                cfg.migrate = parse_migrate(v, &mut issues);
            }
            if let Some(v) = o.get("verify") {
                match v.as_object() {
                    None => issues.add("verify", "\"verify\" must be an object"),
                    Some(vo) => {
                        if let Some(k) = vo.keys().find(|k| k.as_str() != "handEdits") {
                            issues.add(
                                "verify",
                                format!(
                                    "\"verify\" has an unknown key \"{k}\" (expected \"handEdits\")"
                                ),
                            );
                        }
                        if let Some(h) = vo.get("handEdits") {
                            let list: Vec<String> = HandEditsPolicy::ALL
                                .iter()
                                .map(|v| format!("\"{v}\""))
                                .collect();
                            let message =
                                format!("\"verify.handEdits\" must be one of {}", list.join(", "));
                            cfg.hand_edits = enum_of(
                                h,
                                "verify.handEdits",
                                HandEditsPolicy::ALL,
                                Some(message),
                                &mut issues,
                            )
                            .and_then(|s| HandEditsPolicy::parse(&s));
                        }
                    }
                }
            }
            if let Some(v) = o.get("requirements")
                && let Some(ro) = strict_object(v, "requirements", &["inherit"], &mut issues)
            {
                cfg.requirements_inherit = ro
                    .get("inherit")
                    .and_then(|v| string_array(v, "requirements.inherit", true, &mut issues));
            }
            if let Some(v) = o.get("naming") {
                cfg.naming = parse_naming(v, naming, &mut issues);
            }
            if let Some(v) = o.get("wire") {
                cfg.wire = parse_wire(v, &mut issues);
            }
            if let Some(v) = o.get("api") {
                cfg.api = parse_api(v, &mut issues);
            }
            if let Some(v) = o.get("enums") {
                cfg.enums = parse_enums(v, &mut issues);
            }
            if let Some(v) = o.get("csharp") {
                cfg.csharp = parse_csharp(v, &mut issues);
            }
        }
    }
    if issues.0.is_empty() {
        Ok(LoadedConfig {
            config: cfg,
            warnings,
        })
    } else {
        Err(MetaError::code(
            ERR_BAD_ATTR_VALUE,
            describe_config_error(display_path, &issues),
        ))
    }
}

/// Parse config text (JSON). Malformed JSON is `ERR_MALFORMED_JSON`; an invalid
/// config is `ERR_BAD_ATTR_VALUE`.
pub fn parse_config_text(
    text: &str,
    display_path: &str,
    naming: &NamingRegistry,
) -> Result<LoadedConfig, MetaError> {
    let doc: Value = serde_json::from_str(text)
        .map_err(|e| MetaError::code(ERR_MALFORMED_JSON, format!("{display_path}: {e}")))?;
    parse_config(&doc, display_path, naming)
}

/// Read `<meta_root>/config.json`, where `meta_root` is the `.metaobjects` directory.
pub fn load_config(meta_root: &Path, naming: &NamingRegistry) -> Result<LoadedConfig, MetaError> {
    let path = meta_root.join(CONFIG_FILE);
    let shown = path.display().to_string();
    let text = std::fs::read_to_string(&path)
        .map_err(|e| MetaError::code(ERR_UNKNOWN, format!("{shown}: cannot read config: {e}")))?;
    parse_config_text(&text, &shown, naming)
}
