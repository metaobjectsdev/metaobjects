//! The extract pipeline: strip fences, locate the payload, read it tolerantly, then
//! classify and coerce every declared field. Never fails. Mirrors `extract.py`.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::coerce;
use super::json_reader::{self, Raw};
use super::locate;
use super::strip;
use super::types::{
    Coercion, ExtractOptions, ExtractSchema, ExtractionOutcome, ExtractionReport, FieldExtraction,
    FieldKind, FieldSpec, Format, Tolerance,
};
use super::xml_reader::{self, TEXT_KEY};

/// Extract structured data from a model's reply per `schema`.
#[must_use]
pub fn extract(
    text: Option<&str>,
    schema: &ExtractSchema,
    opts: &ExtractOptions,
) -> ExtractionOutcome {
    let mut report = ExtractionReport::default();
    let mut data = Map::new();
    let stripped = strip::strip(text);
    let ci = opts.tolerance != Tolerance::Strict;

    let located = opts
        .on_locate
        .as_ref()
        .and_then(|hook| hook(text.unwrap_or(""), schema.format));

    let (raw, region_blank) = if let Some(span) = located {
        let raw = match schema.format {
            Format::Json => json_reader::read(&span),
            Format::Xml if opts.rootless => xml_reader::read_rootless(&span, ci),
            Format::Xml => xml_reader::read(&span, ci),
        };
        // The located span's LENGTH, not its text: the report should not carry a copy of
        // an arbitrarily large reply.
        report.add_coercion(Coercion::new(
            "",
            "",
            &span.chars().count().to_string(),
            "onLocate",
        ));
        (raw, span.trim().is_empty())
    } else {
        let span = match schema.format {
            Format::Json => select_json(text, &stripped, &schema.fields, ci),
            Format::Xml if opts.rootless => (!stripped.is_empty()).then(|| stripped.clone()),
            Format::Xml => locate::xml(&stripped, &schema.root_name, ci),
        };
        let raw = match (&span, schema.format) {
            (None, _) => IndexMap::new(),
            (Some(s), Format::Json) => json_reader::read(s),
            (Some(s), Format::Xml) if opts.rootless => xml_reader::read_rootless(s, ci),
            (Some(s), Format::Xml) => xml_reader::read(s, ci),
        };
        (raw, stripped.is_empty() || span.is_none())
    };

    if raw.is_empty() && region_blank {
        report.mark_empty();
    }
    extract_fields(&schema.fields, &raw, "", &mut data, &mut report, opts, ci);
    ExtractionOutcome { data, report }
}

fn lost(f: &FieldSpec) -> FieldExtraction {
    if f.required {
        FieldExtraction::LostRequired
    } else {
        FieldExtraction::LostOptional
    }
}

fn extract_fields(
    fields: &[FieldSpec],
    raw: &IndexMap<String, Raw>,
    prefix: &str,
    data: &mut Map<String, Value>,
    report: &mut ExtractionReport,
    opts: &ExtractOptions,
    ci: bool,
) {
    for f in fields {
        let path = if prefix.is_empty() {
            f.name.clone()
        } else {
            format!("{prefix}.{}", f.name)
        };
        let present = if f.text_content {
            raw.get(TEXT_KEY)
        } else {
            lookup(raw, &f.name, ci)
        };
        let Some(present) = present else {
            // An absent field with a @default is filled from it, DEFAULTED, which satisfies
            // @required. A default that does not coerce to the field's kind is no default.
            if let Some(d) = &f.default_value {
                let coerced = if f.kind == FieldKind::Enum {
                    Some(Value::String(d.clone()))
                } else {
                    coerce::scalar(d, f)
                };
                if let Some(v) = coerced {
                    data.insert(f.name.clone(), v);
                    report.add_coercion(Coercion::new(&path, "", d, "default"));
                    report.set(&path, FieldExtraction::Defaulted);
                    if f.required {
                        report.mark_defaulted_required(&path);
                    }
                    continue;
                }
            }
            report.set(&path, lost(f));
            continue;
        };
        match present {
            Raw::Truncated => {
                mark_malformed(report, &path, f);
                continue;
            }
            // An explicit null is a value, not an omission: the field stays null and its
            // @default does not apply.
            Raw::Null => {
                report.set(&path, lost(f));
                continue;
            }
            _ => {}
        }
        if f.array {
            let single = [present.clone()];
            let elements: &[Raw] = match present {
                Raw::List(xs) => xs,
                _ => &single,
            };
            let mut out = Vec::new();
            let mut any_malformed = false;
            let enum_elements = f.kind == FieldKind::Enum;
            for (idx, el) in elements.iter().enumerate() {
                let elem_path = format!("{path}[{idx}]");
                match extract_value(f, el, &elem_path, report, opts, ci) {
                    None => {
                        any_malformed = true;
                        if enum_elements {
                            report.set(&elem_path, FieldExtraction::Malformed);
                        }
                    }
                    Some(v) => {
                        out.push(v);
                        if enum_elements {
                            let state = classify_coerced(&elem_path, report);
                            report.set(&elem_path, state);
                        }
                    }
                }
            }
            // A malformed array keeps the elements that did coerce. Bounds: too many are
            // truncated (recorded) unless strict; too few cannot be repaired.
            let mut out_of_bounds = false;
            if !any_malformed
                && let Some(max) = f.max_items
                && out.len() > max
            {
                if opts.tolerance == Tolerance::Strict {
                    out_of_bounds = true;
                } else {
                    report.add_coercion(Coercion::new(
                        &path,
                        &out.len().to_string(),
                        &max.to_string(),
                        "truncate",
                    ));
                    out.truncate(max);
                }
            }
            if !any_malformed
                && let Some(min) = f.min_items
                && out.len() < min
            {
                out_of_bounds = true;
            }
            data.insert(f.name.clone(), Value::Array(out));
            if any_malformed || out_of_bounds {
                mark_malformed(report, &path, f);
            } else {
                report.set(&path, FieldExtraction::Extracted);
            }
            continue;
        }
        if matches!(present, Raw::List(_)) {
            mark_malformed(report, &path, f);
            continue;
        }
        match extract_value(f, present, &path, report, opts, ci) {
            None => mark_malformed(report, &path, f),
            Some(v) => {
                data.insert(f.name.clone(), v);
                let state = classify_coerced(&path, report);
                report.set(&path, state);
            }
        }
    }
}

fn mark_malformed(report: &mut ExtractionReport, path: &str, f: &FieldSpec) {
    report.set(path, FieldExtraction::Malformed);
    if f.required {
        report.mark_malformed_required(path);
    }
}

/// DEFAULTED when the last coercion recorded for `path` is a default-class fallback.
fn classify_coerced(path: &str, report: &ExtractionReport) -> FieldExtraction {
    let terminal = report
        .coercions()
        .iter()
        .rev()
        .find(|c| c.field_path == path)
        .map(|c| c.kind.as_str());
    match terminal {
        Some("coerceDefault" | "default") => FieldExtraction::Defaulted,
        _ => FieldExtraction::Extracted,
    }
}

fn extract_value(
    f: &FieldSpec,
    present: &Raw,
    path: &str,
    report: &mut ExtractionReport,
    opts: &ExtractOptions,
    ci: bool,
) -> Option<Value> {
    if f.kind == FieldKind::Object {
        let (Some(nested), Raw::Map(m)) = (&f.nested, present) else {
            return None;
        };
        let mut nested_data = Map::new();
        extract_fields(&nested.fields, m, path, &mut nested_data, report, opts, ci);
        return Some(Value::Object(nested_data));
    }
    let text = match present {
        Raw::Str(s) => s.as_str(),
        // An element with attributes carries its text under #text; one with only child
        // elements is not a scalar value.
        Raw::Map(m) => match m.get(TEXT_KEY) {
            Some(Raw::Str(s)) => s.as_str(),
            _ => return None,
        },
        Raw::List(_) | Raw::Truncated | Raw::Null => return None,
    };
    coerce::value(text, f, opts, path, report)
}

/// Pick the JSON object that answers the schema: fenced blocks first, then the whole
/// reply, the first object carrying a declared field; else the first-object rule.
fn select_json(
    text: Option<&str>,
    stripped: &str,
    fields: &[FieldSpec],
    ci: bool,
) -> Option<String> {
    let mut regions = strip::fenced_bodies(text);
    regions.push(stripped.to_string());
    for region in &regions {
        for candidate in locate::json_candidates(region) {
            let parsed = json_reader::read(&candidate);
            if fields
                .iter()
                .any(|f| lookup(&parsed, &f.name, ci).is_some())
            {
                return Some(candidate);
            }
        }
    }
    locate::json(stripped)
}

fn lookup<'a>(raw: &'a IndexMap<String, Raw>, name: &str, ci: bool) -> Option<&'a Raw> {
    if let Some(v) = raw.get(name) {
        return Some(v);
    }
    if ci {
        let lower = name.to_lowercase();
        return raw
            .iter()
            .find(|(k, _)| k.to_lowercase() == lower)
            .map(|(_, v)| v);
    }
    None
}
