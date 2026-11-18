//! The `.metaobjects/config.json` reader, source walk, discovery and shipped
//! libraries: the shared config-block corpora plus the behaviour the source
//! resolution corpus cannot express.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use metaobjects::collection::{discover_collection_root, resolve_collection};
use metaobjects::config::{
    DependencyTransport, HandEditsPolicy, LoadedConfig, UnknownFieldsMode, WireDecimals,
    WireDurations, WireNullMembers, parse_config, parse_config_text,
};
use metaobjects::errors::{
    ERR_BAD_ATTR_VALUE, ERR_COLLECTION_NOT_FOUND, ERR_MALFORMED_JSON, ERR_SOURCE_UNRESOLVED,
    ERR_UNKNOWN_LIBRARY, MetaError,
};
use metaobjects::library::{
    known_library_tokens, library_manifests, library_packages, library_ref_text, library_refs,
    library_sources, split_layer_token,
};
use metaobjects::naming::NamingRegistry;
use metaobjects::sources::list_metadata_files;
use serde_json::{Value, json};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

fn corpus(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(rel)).unwrap()).unwrap()
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "mo-config-reader-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn config(&self, cfg: &Value) {
        self.write(".metaobjects/config.json", &cfg.to_string());
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn parse(block_key: &str, block: &Value) -> Result<LoadedConfig, MetaError> {
    let mut doc = json!({ "schema_version": 1 });
    if !block.is_null() {
        doc[block_key] = block.clone();
    }
    parse_config(&doc, "config.json", &NamingRegistry::builtin())
}

fn rel_files(root: &Path, files: &[PathBuf]) -> Vec<String> {
    files
        .iter()
        .map(|f| f.strip_prefix(root).unwrap().to_string_lossy().into_owned())
        .collect()
}

// --- shared config-block corpora ------------------------------------------

#[test]
fn api_block_corpus() {
    let doc = corpus("api-contract-conformance/api-settings/config-blocks.json");
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let cfg = parse("api", &c["api"])
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .config;
        match &c["pagination"] {
            Value::Null => assert!(cfg.api_pagination().is_none(), "{name}"),
            p => {
                let got = cfg
                    .api_pagination()
                    .unwrap_or_else(|| panic!("{name}: no pagination"));
                assert_eq!(
                    u64::from(got.default_limit),
                    p["defaultLimit"].as_f64().unwrap() as u64,
                    "{name}"
                );
                assert_eq!(
                    u64::from(got.max_limit),
                    p["maxLimit"].as_f64().unwrap() as u64,
                    "{name}"
                );
            }
        }
        let want = c["unknownFields"].as_str().unwrap();
        let got = cfg
            .api_unknown_fields()
            .unwrap_or(UnknownFieldsMode::Reject);
        assert_eq!(got.as_str(), want, "{name}");
    }
    for c in doc["invalid"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let err = parse("api", &c["api"]).expect_err(name);
        assert_eq!(err.code, ERR_BAD_ATTR_VALUE, "{name}");
    }
}

#[test]
fn wire_block_corpus() {
    let doc = corpus("wire-conformance/config-blocks.json");
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let w = parse("wire", &c["wire"])
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .config
            .wire_format();
        assert_eq!(
            w.decimals.as_str(),
            c["decimals"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            w.null_members.as_str(),
            c["nullMembers"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            w.durations.as_str(),
            c["durations"].as_str().unwrap(),
            "{name}"
        );
    }
    for c in doc["invalid"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        assert!(parse("wire", &c["wire"]).is_err(), "{name}");
    }
}

#[test]
fn wire_resolves_to_typed_values() {
    let w = parse(
        "wire",
        &json!({"decimals": "string", "nullMembers": "omit", "durations": "iso"}),
    )
    .unwrap()
    .config
    .wire_format();
    assert_eq!(
        (w.decimals, w.null_members, w.durations),
        (
            WireDecimals::String,
            WireNullMembers::Omit,
            WireDurations::Iso
        )
    );
}

#[test]
fn enums_block_corpus() {
    let doc = corpus("enum-length-conformance/cases.json");
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let d = parse("enums", &c["enums"])
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .config
            .enum_defaults();
        let want = c["enums"]["maxLength"].as_f64().map(|f| f as u64);
        assert_eq!(d.max_length, want, "{name}");
    }
    for c in doc["invalid"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        assert!(parse("enums", &c["enums"]).is_err(), "{name}");
    }
}

#[test]
fn naming_block_corpus_for_builtin_strategies() {
    // Cases that name an application-registered strategy need the real naming
    // registry's `register` points; the built-in ones are checked here.
    let doc = corpus("naming-conformance/physical-names/cases.json");
    let builtin = |v: &Value| {
        v.as_object().is_none_or(|o| {
            o.values().all(|s| {
                matches!(
                    s.as_str(),
                    Some("snake_case" | "literal" | "kebab-case" | "pascal")
                )
            })
        })
    };
    let mut ran = 0;
    for c in doc["cases"].as_array().unwrap() {
        if !builtin(&c["naming"]) {
            continue;
        }
        let name = c["name"].as_str().unwrap();
        let n = parse("naming", &c["naming"])
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .config
            .physical_naming();
        assert_eq!(
            n.columns,
            c["naming"]["columns"].as_str().unwrap_or("snake_case"),
            "{name}"
        );
        assert_eq!(
            n.tables,
            c["naming"]["tables"].as_str().unwrap_or("snake_case"),
            "{name}"
        );
        ran += 1;
    }
    assert!(ran >= 6);
    for c in doc["invalid"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let err = parse("naming", &c["naming"]).expect_err(name);
        assert_eq!(err.code, ERR_BAD_ATTR_VALUE, "{name}");
    }
}

// --- the reader ------------------------------------------------------------

#[test]
fn defaults_match_a_bare_schema_version() {
    let l = parse_config(
        &json!({"schema_version": 1}),
        "c.json",
        &NamingRegistry::builtin(),
    )
    .unwrap();
    assert!(l.warnings.is_empty());
    let c = l.config;
    assert!(c.pending_in_git && c.sources.is_empty() && c.dependencies.is_empty());
    assert_eq!(
        (
            c.confidence_thresholds.pending_promote,
            c.confidence_thresholds.drift_warn
        ),
        (0.8, 0.7)
    );
    assert_eq!(c.wire_format(), Default::default());
    assert_eq!(c.physical_naming().columns, "snake_case");
}

#[test]
fn an_unknown_top_level_key_warns_and_resolves() {
    let l = parse_config(
        &json!({"schema_version": 1, "foo": 1}),
        "c.json",
        &NamingRegistry::builtin(),
    )
    .unwrap();
    assert_eq!(l.warnings.len(), 1);
    assert!(l.warnings[0].contains("unknown top-level key \"foo\" ignored"));
}

#[test]
fn a_nested_typo_or_wrong_type_is_an_error() {
    let n = NamingRegistry::builtin();
    for bad in [
        json!({"schema_version": 1, "migrate": {"scopee": ["x"]}}),
        json!({"schema_version": 1, "migrate": {"d1": {"bindingg": "x"}}}),
        json!({"schema_version": 1, "migrate": {"dialect": "mysql"}}),
        json!({"schema_version": 1, "migrate": {"allow": ["drop-everything"]}}),
        json!({"schema_version": 1, "migrate": {"checks": {"skipRedundant": "yes"}}}),
        json!({"schema_version": 1, "scope": {"scopes": []}}),
        json!({"schema_version": 1, "scope": {"include": [""]}}),
        json!({"schema_version": 1, "verify": {"handEdits": "maybe"}}),
        json!({"schema_version": 1, "verify": {"other": 1}}),
        json!({"schema_version": 1, "requirements": {"inheret": []}}),
        json!({"schema_version": 1, "csharp": {"outDir": ""}}),
        json!({"schema_version": 1, "libraries": "iam"}),
        json!({"schema_version": 1, "pending_in_git": "true"}),
        json!({"schema_version": 1, "confidence_thresholds": {"drift_warn": 2}}),
        json!([1]),
    ] {
        assert!(parse_config(&bad, "c.json", &n).is_err(), "{bad}");
    }
}

#[test]
fn the_error_names_the_file_the_path_and_the_sources_hint() {
    let err = parse_config(
        &json!({"schema_version": 1, "sources": ["model"]}),
        "/p/.metaobjects/config.json",
        &NamingRegistry::builtin(),
    )
    .unwrap_err();
    assert!(
        err.message
            .starts_with("/p/.metaobjects/config.json is not a valid MetaObjects config:")
    );
    assert!(err.message.contains("sources[0]:"));
    assert!(err.message.contains("never a bare string"));
}

#[test]
fn extract_and_confidence_thresholds_ignore_unknown_keys_as_the_typescript_reader_does() {
    let c = parse_config(
        &json!({"schema_version": 1, "extract": {"metaignore": ".m", "x": 1}, "confidence_thresholds": {"y": 1}}),
        "c.json",
        &NamingRegistry::builtin(),
    )
    .unwrap()
    .config;
    assert_eq!(c.extract_metaignore.as_deref(), Some(".m"));
}

#[test]
fn migrate_verify_requirements_scope_and_csharp_are_kept() {
    let c = parse_config(
        &json!({
            "schema_version": 1,
            "migrate": {"dialect": "postgres", "scope": ["a::**"], "conventions": "efcore",
                        "checks": {"skipRedundant": true}, "foreignKeyIndexes": true,
                        "d1": {"binding": "DB", "remote": false}, "allow": ["drop-table"]},
            "verify": {"handEdits": "fail"},
            "requirements": {"inherit": ["acme::common"]},
            "scope": {"include": ["a::**"], "exclude": ["a::x"]},
            "csharp": {"outDir": "gen", "providers": [{"assembly": "p.dll", "type": "P.Prov"}]}
        }),
        "c.json",
        &NamingRegistry::builtin(),
    )
    .unwrap()
    .config;
    let m = c.migrate.unwrap();
    assert_eq!(m.dialect.as_deref(), Some("postgres"));
    assert_eq!(m.checks_skip_redundant, Some(true));
    assert_eq!(m.d1.unwrap().binding.as_deref(), Some("DB"));
    assert_eq!(c.hand_edits, Some(HandEditsPolicy::Fail));
    assert_eq!(c.requirements_inherit.unwrap(), ["acme::common"]);
    assert_eq!(c.scope.unwrap().exclude.unwrap(), ["a::x"]);
    assert_eq!(c.csharp.unwrap().providers.unwrap()[0].type_name, "P.Prov");
}

#[test]
fn dependencies_are_validated_and_names_must_be_unique() {
    let n = NamingRegistry::builtin();
    let ok = parse_config(
        &json!({"schema_version": 1, "dependencies": [
            {"name": "a", "path": "../a"},
            {"name": "b", "npm": "@x/b", "dir": "m"},
            {"name": "c", "maven": "g:a", "version": "1"}]}),
        "c.json",
        &n,
    )
    .unwrap()
    .config;
    assert_eq!(ok.dependencies.len(), 3);
    assert!(matches!(
        ok.dependencies[2].transport,
        DependencyTransport::Maven { .. }
    ));
    for bad in [
        json!([{"name": "a", "path": "x"}, {"name": "a", "path": "y"}]),
        json!([{"name": "A", "path": "x"}]),
        json!([{"name": "a"}]),
        json!([{"name": "a", "path": "x", "npm": "y"}]),
        json!([{"name": "a", "path": "x", "dir": "d"}]),
        json!([{"name": "a", "maven": "g:a"}]),
        json!([{"name": "a", "path": "x", "pathh": "typo"}]),
    ] {
        assert!(
            parse_config(
                &json!({"schema_version": 1, "dependencies": bad}),
                "c.json",
                &n
            )
            .is_err(),
            "{bad}"
        );
    }
}

#[test]
fn malformed_json_is_a_coded_error() {
    let e = parse_config_text("{ nope", "c.json", &NamingRegistry::builtin()).unwrap_err();
    assert_eq!(e.code, ERR_MALFORMED_JSON);
}

// --- collection, discovery, walk ----------------------------------------------

#[test]
fn collection_carries_the_declared_settings_and_unresolved_dependencies() {
    let s = Scratch::new();
    s.write("model/meta.a.json", "{}");
    s.config(&json!({
        "schema_version": 1, "sources": [{"path": "model"}],
        "naming": {"columns": "literal"}, "wire": {"decimals": "string"},
        "api": {"unknownFields": "drop"}, "enums": {"maxLength": 16},
        "migrate": {"conventions": "efcore", "checks": {"skipRedundant": true}, "foreignKeyIndexes": true, "scope": ["a::**"]},
        "verify": {"handEdits": "fail"}, "dependencies": [{"name": "d", "path": "../d"}], "foo": 1
    }));
    let c = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap();
    assert_eq!(c.physical_naming.columns, "literal");
    assert_eq!(c.wire_format.decimals, WireDecimals::String);
    assert_eq!(c.api_unknown_fields, Some(UnknownFieldsMode::Drop));
    assert_eq!(c.enum_defaults.max_length, Some(16));
    assert_eq!(c.schema_conventions.as_deref(), Some("efcore"));
    assert!(c.skip_redundant_checks && c.foreign_key_indexes);
    assert_eq!(c.hand_edits, Some(HandEditsPolicy::Fail));
    assert_eq!(c.migrate_scope.as_deref(), Some(&["a::**".to_string()][..]));
    assert_eq!(c.dependencies.len(), 1);
    assert_eq!(c.warnings.len(), 1);
    assert_eq!(c.source_roots, [s.0.join("model")]);
}

#[test]
fn discovery_finds_the_nearest_config_and_stops_at_git() {
    let s = Scratch::new();
    s.write(".git/HEAD", "");
    s.write("a/.metaobjects/config.json", "{\"schema_version\":1}");
    s.write("a/b/.metaobjects/config.json", "{\"schema_version\":1}");
    s.write("a/b/c/d/.keep", "");
    s.write("x/y/.keep", "");
    let found = discover_collection_root(&s.0.join("a/b/c/d"));
    assert_eq!((found.dir, found.has_config), (s.0.join("a/b"), true));
    // The repository boundary stops the walk: no config above `.git` is adopted.
    let none = discover_collection_root(&s.0.join("x/y"));
    assert!(!none.has_config);
    assert_eq!(none.dir, s.0.join("x/y"));
}

#[test]
fn a_repo_root_project_is_found_from_a_subdirectory() {
    let s = Scratch::new();
    s.write(".git/HEAD", "");
    s.config(&json!({"schema_version": 1}));
    s.write("metaobjects/meta.a.json", "{}");
    s.write("pkg/src/.keep", "");
    let c = resolve_collection(&s.0.join("pkg/src"), None, &NamingRegistry::builtin()).unwrap();
    assert_eq!(c.config_dir, s.0);
    assert_eq!(rel_files(&s.0, &c.files), ["metaobjects/meta.a.json"]);
}

#[test]
fn a_metadata_directory_handed_as_the_root_is_diagnosed() {
    let s = Scratch::new();
    s.write(".git/HEAD", "");
    s.write("meta.a.json", "{\"metadata.root\": {}}");
    let e = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap_err();
    assert_eq!(e.code, ERR_COLLECTION_NOT_FOUND);
    assert!(e.message.contains("looks like a metadata directory"));
}

#[test]
fn a_walk_lists_files_before_subdirectories_and_skips_pending() {
    let s = Scratch::new();
    for f in [
        "m/z.json",
        "m/a/inner.json",
        "m/_pending/draft.json",
        "m/b.yaml",
        "m/a/_pending/x.json",
    ] {
        s.write(f, "{}");
    }
    let files = list_metadata_files(&s.0.join("m")).unwrap();
    assert_eq!(
        rel_files(&s.0, &files),
        ["m/b.yaml", "m/z.json", "m/a/inner.json"]
    );
}

#[test]
fn a_directory_reachable_by_two_symlinks_is_a_diamond_not_a_cycle() {
    let s = Scratch::new();
    s.write("m/real/meta.a.json", "{}");
    std::os::unix::fs::symlink(s.0.join("m/real"), s.0.join("m/one")).unwrap();
    std::os::unix::fs::symlink(s.0.join("m/real"), s.0.join("m/two")).unwrap();
    let files = list_metadata_files(&s.0.join("m")).unwrap();
    assert_eq!(files.len(), 3);
}

#[test]
fn a_symlink_that_revisits_an_ancestor_raises_on_the_revisit() {
    let s = Scratch::new();
    s.write("m/meta.a.json", "{}");
    std::os::unix::fs::symlink(s.0.join("m"), s.0.join("m/loop")).unwrap();
    let e = list_metadata_files(&s.0.join("m")).unwrap_err();
    assert!(e.message.contains("symlink loop detected"));
}

#[test]
fn a_dangling_symlink_is_skipped() {
    let s = Scratch::new();
    s.write("m/meta.a.json", "{}");
    std::os::unix::fs::symlink(s.0.join("nowhere"), s.0.join("m/dangling.json")).unwrap();
    assert_eq!(list_metadata_files(&s.0.join("m")).unwrap().len(), 1);
}

#[test]
fn an_absolute_path_source_is_taken_as_written() {
    let s = Scratch::new();
    s.write("elsewhere/meta.a.json", "{}");
    s.config(&json!({"schema_version": 1, "sources": [{"path": s.0.join("elsewhere").to_string_lossy()}]}));
    let c = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap();
    assert_eq!(rel_files(&s.0, &c.files), ["elsewhere/meta.a.json"]);
}

#[test]
fn a_missing_declared_path_is_unresolved_even_beside_a_default_directory() {
    let s = Scratch::new();
    s.write("metaobjects/meta.a.json", "{}");
    s.config(&json!({"schema_version": 1, "sources": [{"path": "nope"}]}));
    let e = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap_err();
    assert_eq!(e.code, ERR_SOURCE_UNRESOLVED);
}

// --- libraries ----------------------------------------------------------------

#[test]
fn the_shipped_tokens_and_manifests_are_embedded() {
    assert_eq!(known_library_tokens(), ["ai", "ai/db", "iam", "iam/db"]);
    assert_eq!(library_manifests()["iam"].name, "iam");
    assert!(library_packages().contains("metaobjects::iam"));
    assert_eq!(split_layer_token("iam/db"), ("iam", "db"));
    assert_eq!(split_layer_token("iam"), ("iam", ""));
    assert_eq!(split_layer_token("a/b/c"), ("a", "b/c"));
}

#[test]
fn every_manifest_ref_has_embedded_text_matching_the_repo_file() {
    for name in library_manifests().keys() {
        for r in library_refs(name) {
            let text = library_ref_text(&r).unwrap_or_else(|| panic!("{r} not embedded"));
            let disk =
                std::fs::read_to_string(fixtures().join("../library").join(format!("{r}.yaml")))
                    .unwrap();
            assert_eq!(text, disk, "{r}");
        }
    }
}

fn ids(sel: &[&str]) -> Vec<String> {
    let sel: Vec<String> = sel.iter().map(|s| (*s).to_string()).collect();
    library_sources(&sel)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

#[test]
fn library_sources_order_core_first_and_a_layer_implies_its_core() {
    assert_eq!(
        ids(&["iam"]),
        ["library:iam/model.yaml", "library:iam/requirements.yaml"]
    );
    assert_eq!(
        ids(&["iam/db"]),
        [
            "library:iam/model.yaml",
            "library:iam/requirements.yaml",
            "library:iam/db.yaml"
        ]
    );
    // Every core layer first, even when a db layer is named before its core.
    assert_eq!(
        ids(&["iam/db", "ai"]),
        [
            "library:iam/model.yaml",
            "library:iam/requirements.yaml",
            "library:ai/model.yaml",
            "library:ai/requirements.yaml",
            "library:iam/db.yaml"
        ]
    );
    assert_eq!(ids(&["iam", "iam", "iam/db"]).len(), 3);
}

#[test]
fn an_unknown_layer_is_dropped_whole_not_reduced_to_its_core() {
    assert!(ids(&["iam/database"]).is_empty());
    assert!(ids(&["nope"]).is_empty());
}

#[test]
fn an_unknown_library_in_a_config_is_refused_with_the_available_tokens() {
    let s = Scratch::new();
    s.write("metaobjects/meta.a.json", "{}");
    s.config(&json!({"schema_version": 1, "libraries": ["iam/database"]}));
    let e = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap_err();
    assert_eq!(e.code, ERR_UNKNOWN_LIBRARY);
    assert!(e.message.contains("\"iam/database\""));
    assert!(e.message.contains("[\"ai\",\"ai/db\",\"iam\",\"iam/db\"]"));
}

#[test]
fn read_sources_puts_libraries_first_then_own_files_and_reports_unreadable_ones() {
    let s = Scratch::new();
    s.write("metaobjects/meta.a.json", "{\"a\":1}");
    s.write("metaobjects/bad.json", "x");
    s.config(&json!({"schema_version": 1, "libraries": ["ai"]}));
    // Not valid UTF-8, so reading it as text fails while the rest still load.
    std::fs::write(s.0.join("metaobjects/bad.json"), [0xff, 0xfe]).unwrap();
    let c = resolve_collection(&s.0, Some(&s.0), &NamingRegistry::builtin()).unwrap();
    let (pairs, errors) = c.read_sources();
    let ids: Vec<&str> = pairs.iter().map(|(i, _)| i.as_str()).collect();
    assert_eq!(
        &ids[..2],
        ["library:ai/model.yaml", "library:ai/requirements.yaml"]
    );
    assert_eq!(ids.len(), 3);
    assert!(ids[2].ends_with("metaobjects/meta.a.json") && Path::new(ids[2]).is_absolute());
    assert_eq!(errors.len(), 1);
    assert!(errors[0].message.contains("bad.json"));
}
