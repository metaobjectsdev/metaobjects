//! Per-phase and per-validation-pass timing of one load.
//!
//! Every load records how long each phase and each validation pass took, so a
//! slowdown can be traced to the feature that caused it. The numbers are for
//! reading, never for failing a build: nothing in the crate asserts on them.
//!
//! The recorder is one `Instant` pair per phase and per pass, so the cost of keeping
//! it is far below the resolution of what it measures.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

/// A load phase, in the order the loader runs them.
pub const PHASE_READ: &str = "read files";
pub const PHASE_JSON: &str = "json parse";
pub const PHASE_TREE: &str = "tree build";
pub const PHASE_MERGE: &str = "merge";
pub const PHASE_SUPERS: &str = "super resolution";
pub const PHASE_VALIDATE: &str = "validation";
pub const PHASE_REFS: &str = "reference resolution";
pub const PHASE_FREEZE: &str = "freeze";

/// One named measurement.
#[derive(Debug, Clone, PartialEq)]
pub struct Timing {
    pub name: &'static str,
    pub duration: Duration,
}

/// The phases and validation passes of one load, each in the order it first ran.
/// A name recorded twice (one parse per file) accumulates into one entry.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadTimings {
    pub phases: Vec<Timing>,
    pub passes: Vec<Timing>,
}

fn add(list: &mut Vec<Timing>, name: &'static str, duration: Duration) {
    match list.iter_mut().find(|t| t.name == name) {
        Some(t) => t.duration += duration,
        None => list.push(Timing { name, duration }),
    }
}

impl LoadTimings {
    /// Add `duration` to the phase `name`.
    pub fn add_phase(&mut self, name: &'static str, duration: Duration) {
        add(&mut self.phases, name, duration);
    }

    /// Add `duration` to the validation pass `name`.
    pub fn add_pass(&mut self, name: &'static str, duration: Duration) {
        add(&mut self.passes, name, duration);
    }

    /// Run `f`, recording its time under the phase `name`.
    pub fn phase<T>(&mut self, name: &'static str, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let out = f();
        self.add_phase(name, start.elapsed());
        out
    }

    /// Run `f`, recording its time under the validation pass `name`.
    pub fn pass<T>(&mut self, name: &'static str, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let out = f();
        self.add_pass(name, start.elapsed());
        out
    }

    /// The time recorded for phase `name`, zero when it never ran.
    pub fn phase_time(&self, name: &str) -> Duration {
        self.phases
            .iter()
            .find(|t| t.name == name)
            .map_or(Duration::ZERO, |t| t.duration)
    }

    /// The sum of every phase.
    pub fn total(&self) -> Duration {
        self.phases.iter().map(|t| t.duration).sum()
    }
}

/// Milliseconds with three decimals: the unit every table prints.
pub fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// A fixed-width table of `rows` (name, milliseconds), each against its baseline
/// milliseconds when `baseline` carries that name. A name with no baseline row prints
/// `new`; a baseline row nobody measured prints nothing (the pass was removed).
pub fn render_table(
    title: &str,
    rows: &[(String, f64)],
    baseline: Option<&[(String, f64)]>,
) -> String {
    let width = rows
        .iter()
        .map(|(n, _)| n.len())
        .max()
        .unwrap_or(0)
        .max(title.len());
    let mut out = String::new();
    match baseline {
        Some(_) => writeln!(
            out,
            "{title:<width$}  {:>10}  {:>10}  {:>9}",
            "ms", "baseline", "delta"
        ),
        None => writeln!(out, "{title:<width$}  {:>10}", "ms"),
    }
    .ok();
    for (name, now) in rows {
        match baseline {
            None => writeln!(out, "{name:<width$}  {now:>10.3}"),
            Some(base) => match base.iter().find(|(n, _)| n == name) {
                Some((_, was)) => {
                    let delta = if *was > 0.0 {
                        format!("{:+.1}%", (now - was) / was * 100.0)
                    } else {
                        "n/a".to_string()
                    };
                    writeln!(out, "{name:<width$}  {now:>10.3}  {was:>10.3}  {delta:>9}")
                }
                None => writeln!(
                    out,
                    "{name:<width$}  {now:>10.3}  {:>10}  {:>9}",
                    "-", "new"
                ),
            },
        }
        .ok();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_recorded_twice_accumulates_in_first_seen_order() {
        let mut t = LoadTimings::default();
        t.add_phase("a", Duration::from_millis(2));
        t.add_phase("b", Duration::from_millis(1));
        t.add_phase("a", Duration::from_millis(3));
        assert_eq!(t.phases.len(), 2);
        assert_eq!(t.phases[0].name, "a");
        assert_eq!(t.phase_time("a"), Duration::from_millis(5));
        assert_eq!(t.total(), Duration::from_millis(6));
        assert_eq!(t.phase_time("missing"), Duration::ZERO);
    }

    #[test]
    fn the_table_prints_the_delta_against_the_baseline() {
        let rows = vec![("merge".to_string(), 1.5), ("fresh".to_string(), 2.0)];
        let base = vec![("merge".to_string(), 1.0)];
        let table = render_table("phase", &rows, Some(&base));
        assert!(table.contains("+50.0%"), "{table}");
        assert!(table.contains("new"), "{table}");
    }
}
