//! The `metamodel-docs` generator: the reference of the built-in metamodel, every type,
//! subtype and attribute the build registers, by provider.
//!
//! It reads no model object. The page data comes from this build's registry manifest and its
//! embedded provider definitions (`metaobjects::metamodel_docs::build_pages`, the core: it
//! decides what there is to write), and the pages are the shared `templates/metamodel/`
//! Mustache set rendered over it. A project's own `templates/metamodel/<page>.mustache`
//! (`index.md`, `providers.md`, `type-page.md`) wins over the shipped one. Writes, under
//! `metamodel/` (the `dir` option; `""` writes at the output root):
//!
//! ```text
//! INDEX.md  providers.md  types/<family>.md
//! ```

use metaobjects::manifest::build_manifest;
use metaobjects::metamodel_docs::{build_pages, parse_definitions};
use metaobjects::providers::default_registry;
use metaobjects_codegen::generator::{
    EmittedFile, GenContext, GenError, Generator, Options, unknown_options,
};
use metaobjects_codegen::plan::{shipped_provider_descriptions, shipped_template};
use metaobjects_codegen::render::{Body, Provider, RenderRequest, render};

/// Bump when the emitted text changes shape, so a stored skip key never survives it.
const FORMAT: u32 = 1;

/// Where a project's own templates live, from the project root.
const TEMPLATE_DIR: &str = "templates";
/// The default sub-directory of the output the pages are written under.
const DEFAULT_DIR: &str = "metamodel";
const OPTION_DIR: &str = "dir";
/// The failure of this generator.
const ERR_METAMODEL_DOCS: &str = "ERR_METAMODEL_DOCS";

/// The metamodel-docs generator.
#[derive(Debug, Clone, Copy, Default)]
pub struct MetamodelDocsGenerator;

/// The generator as a project configured it (`{"name": "metamodel-docs", "options": {"dir": ""}}`).
#[derive(Debug, Clone)]
pub struct ConfiguredMetamodelDocs {
    dir: String,
}

impl Generator for MetamodelDocsGenerator {
    fn name(&self) -> &str {
        "metamodel-docs"
    }

    fn identity(&self) -> String {
        format!("metamodel-docs:{FORMAT}:{DEFAULT_DIR}")
    }

    fn extra_inputs(&self) -> Vec<String> {
        vec![format!("{TEMPLATE_DIR}/metamodel")]
    }

    fn configure(&self, options: &Options) -> Result<Box<dyn Generator>, GenError> {
        if options.keys().any(|k| k != OPTION_DIR) {
            return Err(unknown_options(self.name(), options, &[OPTION_DIR]));
        }
        let dir = match options.get(OPTION_DIR) {
            None => DEFAULT_DIR.to_string(),
            Some(serde_json::Value::String(s)) => s.trim_matches('/').to_string(),
            Some(other) => {
                return Err(GenError::new(
                    ERR_METAMODEL_DOCS,
                    format!(
                        "the generator metamodel-docs takes \"{OPTION_DIR}\" as a string, got {other}"
                    ),
                ));
            }
        };
        Ok(Box::new(ConfiguredMetamodelDocs { dir }))
    }

    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        pages_under(DEFAULT_DIR, ctx)
    }
}

impl Generator for ConfiguredMetamodelDocs {
    fn name(&self) -> &str {
        "metamodel-docs"
    }

    fn identity(&self) -> String {
        format!("metamodel-docs:{FORMAT}:{}", self.dir)
    }

    fn extra_inputs(&self) -> Vec<String> {
        vec![format!("{TEMPLATE_DIR}/metamodel")]
    }

    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        pages_under(&self.dir, ctx)
    }
}

/// Every page, rendered, under `dir` of the output (`""` for its root).
pub fn pages_under(dir: &str, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
    let registry =
        default_registry().map_err(|e| GenError::new(ERR_METAMODEL_DOCS, e.to_string()))?;
    let pages = build_pages(
        &build_manifest(&registry),
        &parse_definitions(),
        &shipped_provider_descriptions(),
    );
    let templates = Templates {
        project_templates: ctx.collection.config_dir.join(TEMPLATE_DIR),
    };
    let mut files = Vec::with_capacity(pages.len());
    for page in pages {
        let request = RenderRequest::new(Body::Ref(page.template), &page.data, &templates);
        let text = render(&request)
            .map_err(|e| GenError::new(ERR_METAMODEL_DOCS, format!("{}: {e}", page.path)))?;
        let path = if dir.is_empty() {
            page.path
        } else {
            format!("{dir}/{}", page.path)
        };
        files.push(EmittedFile::new(path, text));
    }
    Ok(files)
}

/// Resolves a template ref: the project's `templates/<ref>.mustache` if it has one, else the
/// shipped text.
struct Templates {
    project_templates: std::path::PathBuf,
}

impl Provider for Templates {
    fn resolve(&self, reference: &str) -> Option<String> {
        std::fs::read_to_string(self.project_templates.join(format!("{reference}.mustache")))
            .ok()
            .or_else(|| shipped_template(reference).map(str::to_string))
    }
}
