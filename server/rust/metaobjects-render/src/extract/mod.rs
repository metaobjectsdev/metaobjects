//! The reply parser (FR-010, FR-011): tolerant extraction of a typed answer from a model's
//! dirty reply.
//!
//! A model asked for JSON or XML answers with fences, prose, comments, trailing commas,
//! cut-off values and synonyms. [`extract`] reads what it can, classifies every declared
//! field ([`FieldExtraction`]) and coerces each value to its kind, and never fails: a
//! caller decides from the report whether the answer is good enough
//! ([`ExtractionReport::fails_strict`]). The shared `fixtures/extract-conformance/` corpus
//! holds this module to the other ports.

pub(crate) mod coerce;
mod engine;
pub mod json_reader;
pub mod locate;
pub mod normalize;
pub mod strip;
mod types;
pub mod xml_reader;

use serde::de::DeserializeOwned;
use serde_json::Value;

pub use engine::extract;
pub use types::{
    Coercion, ExtractOptions, ExtractSchema, ExtractionOutcome, ExtractionReport, FieldExtraction,
    FieldKind, FieldSpec, Format, Normalizer, OnField, OnLocate, Tolerance,
};

/// A reply read into a typed answer: the typed value when the extracted fields make a
/// complete one, and always the forgiving data and its report.
#[derive(Debug, Clone)]
pub struct Extracted<T> {
    /// The answer as `T`, or `None` when the extracted fields do not make one (a required
    /// member lost, or a value `T` does not accept). [`outcome`](Self::outcome) says why.
    pub value: Option<T>,
    pub outcome: ExtractionOutcome,
}

/// [`extract`], then read the extracted fields as `T`: the tolerant path of a generated
/// response parser. Never fails.
#[must_use]
pub fn extract_into<T: DeserializeOwned>(
    text: Option<&str>,
    schema: &ExtractSchema,
    opts: &ExtractOptions,
) -> Extracted<T> {
    let outcome = extract(text, schema, opts);
    let value = serde_json::from_value(Value::Object(outcome.data.clone())).ok();
    Extracted { value, outcome }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct Answer {
        verdict: String,
        score: Option<i64>,
    }

    fn schema() -> ExtractSchema {
        ExtractSchema {
            format: Format::Json,
            root_name: "Answer".to_string(),
            fields: vec![
                FieldSpec::scalar("verdict", FieldKind::String, true),
                FieldSpec::scalar("score", FieldKind::Long, false),
            ],
        }
    }

    #[test]
    fn a_complete_reply_reads_as_the_type_and_an_incomplete_one_keeps_only_its_report() {
        let opts = ExtractOptions::default();
        let got: Extracted<Answer> = extract_into(
            Some("Sure! ```json\n{\"verdict\": \"yes\", \"score\": \"7\",}\n```"),
            &schema(),
            &opts,
        );
        assert_eq!(
            got.value,
            Some(Answer {
                verdict: "yes".into(),
                score: Some(7)
            })
        );

        let got: Extracted<Answer> = extract_into(Some("{\"score\": 3}"), &schema(), &opts);
        assert_eq!(got.value, None);
        assert_eq!(
            got.outcome.report.states().get("verdict"),
            Some(&FieldExtraction::LostRequired)
        );
    }
}
