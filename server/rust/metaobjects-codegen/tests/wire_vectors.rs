//! The shared decimal and duration wire vectors (`fixtures/decimal-wire/`,
//! `fixtures/duration-wire/`), run against the code a generated crate carries.
//!
//! `metaobjects_codegen::emitted::wire` is the module the `entity` generator writes
//! verbatim as `meta_support/src/wire.rs`, so passing here is passing in the generated code.

use std::path::PathBuf;

use metaobjects_codegen::emitted::wire::{Decimal, Duration};
use serde_json::Value;

/// The fraction digits this port keeps: a Rust duration is held in nanoseconds.
const RUST_PRECISION: &str = "9";

fn vectors(corpus: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures")
        .join(corpus)
        .join("vectors.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("the vectors file"))
        .expect("vectors JSON")
}

fn rows<'a>(value: &'a Value, what: &str) -> &'a Vec<Value> {
    let rows = value
        .as_array()
        .unwrap_or_else(|| panic!("{what} is a list"));
    assert!(!rows.is_empty(), "{what} has no vectors");
    rows
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} in {row}"))
}

#[test]
fn decimals_are_written_in_the_canonical_form() {
    let v = vectors("decimal-wire");
    for row in rows(&v["format"], "format") {
        let got = Decimal::parse(text(row, "in")).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(got.as_str(), text(row, "out"), "{row}");
        assert_eq!(
            serde_json::to_string(&got).unwrap(),
            format!("\"{}\"", text(row, "out")),
            "{row}"
        );
    }
}

#[test]
fn decimals_are_read_from_a_string_or_a_number_and_nothing_else() {
    let v = vectors("decimal-wire");
    for row in rows(&v["parse"], "parse") {
        let got = serde_json::from_str::<Option<Decimal>>(text(row, "json"));
        if row.get("error").and_then(Value::as_bool) == Some(true) {
            assert!(got.is_err(), "{row} was accepted as {got:?}");
            continue;
        }
        let got = got.unwrap_or_else(|e| panic!("{row}: {e}"));
        assert_eq!(
            got.as_ref().map(Decimal::as_str),
            row["value"].as_str(),
            "{row}"
        );
    }
}

#[test]
fn a_decimal_filter_operand_follows_the_same_grammar() {
    let v = vectors("decimal-wire");
    for row in rows(&v["filterOperand"], "filterOperand") {
        let got = Decimal::parse(text(row, "text"));
        if row.get("error").and_then(Value::as_bool) == Some(true) {
            assert!(got.is_err(), "{row} was accepted as {got:?}");
        } else {
            assert_eq!(got.unwrap().as_str(), text(row, "value"), "{row}");
        }
    }
}

#[test]
fn a_float_becomes_its_fifteen_digit_decimal() {
    let v = vectors("decimal-wire");
    for row in rows(&v["double15"], "double15") {
        let double: f64 = text(row, "double").parse().expect("a float");
        let got = Decimal::from_f64(double).expect("finite");
        assert_eq!(got.as_str(), text(row, "out"), "{row}");
    }
    assert!(Decimal::from_f64(f64::NAN).is_none());
    assert!(Decimal::from_f64(f64::INFINITY).is_none());
}

#[test]
fn decimals_order_by_value_and_report_their_digits() {
    let d = |s: &str| Decimal::parse(s).unwrap();
    let mut sorted = [
        d("10"),
        d("-0.5"),
        d("9.99"),
        d("0"),
        d("-12"),
        d("0.05"),
        d("0.5"),
    ];
    sorted.sort();
    let texts: Vec<&str> = sorted.iter().map(Decimal::as_str).collect();
    assert_eq!(texts, ["-12", "-0.5", "0", "0.05", "0.5", "9.99", "10"]);
    assert_eq!(d("1.0"), d("1"), "equal values are equal");
    assert!(d("123.45").fits(5, 2));
    assert!(!d("123.456").fits(6, 2), "nothing is rounded to fit");
    assert!(!d("1234.5").fits(5, 2));
    assert!(
        d("0.25").fits(2, 2),
        "a value below one has no integer digits"
    );
    assert!(
        Decimal::parse("1e999999").is_err(),
        "a huge exponent is refused"
    );
    assert_eq!(d("0e999999").as_str(), "0");
}

#[test]
fn durations_parse_and_print_in_the_canonical_form() {
    let v = vectors("duration-wire");
    for row in rows(&v["wire"]["parse"], "wire.parse") {
        let got = Duration::parse(text(row, "in")).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(got.to_string(), text(row, "out"), "{row}");
        assert_eq!(
            serde_json::to_string(&got).unwrap(),
            format!("\"{}\"", text(row, "out")),
            "{row}"
        );
    }
}

#[test]
fn durations_keep_nine_fraction_digits_and_drop_the_rest() {
    let v = vectors("duration-wire");
    for row in rows(&v["wire"]["precision"], "wire.precision") {
        let got = Duration::parse(text(row, "in")).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(got.to_string(), text(&row["out"], RUST_PRECISION), "{row}");
    }
}

#[test]
fn durations_outside_the_grammar_are_refused() {
    let v = vectors("duration-wire");
    for row in rows(&v["wire"]["refused"], "wire.refused") {
        let refused = row.as_str().expect("refused text");
        assert!(
            Duration::parse(refused).is_err(),
            "{refused:?} was accepted"
        );
        assert!(
            serde_json::from_value::<Duration>(Value::from(refused)).is_err(),
            "{refused:?} was accepted from JSON"
        );
    }
    assert!(
        serde_json::from_str::<Duration>("90").is_err(),
        "a number is not a duration"
    );
}

#[test]
fn durations_order_by_length() {
    let d = |s: &str| Duration::parse(s).unwrap();
    assert!(d("PT45M") < d("PT1H"));
    assert!(d("-PT1H") < d("PT0S"));
    assert_eq!(d("PT90M"), d("PT1H30M"));
    assert_eq!(d("P1D").nanos(), 86_400_000_000_000);
}
