//! Derived projections: blocked, held and ready, computed from the whole task list.

use std::collections::{HashMap, HashSet};
use tasks_axi_gen::enums::{DepType, TaskState};
use tasks_axi_gen::model::Task;

/// The task a dependency id points at. As in the Node tool's `new Map(...)`, a later task with a
/// duplicated id wins.
fn by_id(tasks: &[Task]) -> HashMap<&str, &Task> {
    tasks.iter().map(|t| (t.id.as_str(), t)).collect()
}

/// Tasks that are not done and wait on a blocker that exists and is not done. A dangling
/// `blocked-by` edge counts as resolved.
pub fn blocked_ids(tasks: &[Task]) -> HashSet<String> {
    let index = by_id(tasks);
    let mut blocked = HashSet::new();
    for task in tasks {
        if task.state == TaskState::Done {
            continue;
        }
        let waits = task
            .deps
            .iter()
            .filter(|d| d.r#type == DepType::BlockedBy)
            .any(|d| {
                index
                    .get(d.id.as_str())
                    .is_some_and(|b| b.state != TaskState::Done)
            });
        if waits {
            blocked.insert(task.id.clone());
        }
    }
    blocked
}

/// The unresolved `blocked-by` edges of `task`, in declaration order.
pub fn active_blockers(task: &Task, tasks: &[Task]) -> Vec<String> {
    let index = by_id(tasks);
    task.deps
        .iter()
        .filter(|d| d.r#type == DepType::BlockedBy)
        .filter(|d| {
            index
                .get(d.id.as_str())
                .is_some_and(|b| b.state != TaskState::Done)
        })
        .map(|d| d.id.clone())
        .collect()
}

/// True when a structured hold is in force today (a `hold-until` date is a strict upper bound).
pub fn is_hold_active(task: &Task, today: &dyn Fn() -> String) -> bool {
    let Some(hold) = &task.hold else { return false };
    match &hold.until {
        None => task.state != TaskState::Done,
        // ISO dates are ASCII, so byte order is the UTF-16 order JavaScript compares in.
        Some(until) => task.state != TaskState::Done && until.as_str() > today().as_str(),
    }
}

pub fn held_tasks<'a>(tasks: &'a [Task], today: &dyn Fn() -> String) -> Vec<&'a Task> {
    tasks.iter().filter(|t| is_hold_active(t, today)).collect()
}

/// Unblocked, unheld queued work (held work too when `include_held`).
pub fn ready_tasks<'a>(
    tasks: &'a [Task],
    include_held: bool,
    today: &dyn Fn() -> String,
) -> Vec<&'a Task> {
    let blocked = blocked_ids(tasks);
    tasks
        .iter()
        .filter(|t| {
            t.state == TaskState::Queued
                && t.kind.as_deref() != Some("public-followup")
                && !blocked.contains(&t.id)
                && (include_held || !is_hold_active(t, today))
        })
        .collect()
}

/// The local calendar date as `YYYY-MM-DD`: what `new Date()`'s local getters give the Node tool.
#[cfg(unix)]
pub fn local_date() -> String {
    #[repr(C)]
    struct Tm {
        tm_sec: i32,
        tm_min: i32,
        tm_hour: i32,
        tm_mday: i32,
        tm_mon: i32,
        tm_year: i32,
        tm_wday: i32,
        tm_yday: i32,
        tm_isdst: i32,
        tm_gmtoff: i64,
        tm_zone: *const u8,
    }
    extern "C" {
        fn time(t: *mut i64) -> i64;
        fn tzset();
        fn localtime_r(t: *const i64, out: *mut Tm) -> *mut Tm;
    }
    // SAFETY: `Tm` matches the C `struct tm` on 64-bit glibc, musl and the BSD/macOS libc (nine
    // ints, then a long and a pointer); every pointer passed is to a live local.
    unsafe {
        let mut now: i64 = 0;
        time(&mut now);
        tzset();
        let mut tm: Tm = std::mem::zeroed();
        if !localtime_r(&now, &mut tm).is_null() {
            return format!(
                "{}-{:02}-{:02}",
                tm.tm_year + 1900,
                tm.tm_mon + 1,
                tm.tm_mday
            );
        }
        civil_from_unix(now)
    }
}

#[cfg(not(unix))]
pub fn local_date() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_from_unix(now)
}

/// The UTC date of a unix timestamp (days-from-civil inverse), the fallback with no local zone.
fn civil_from_unix(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_from_unix_seconds() {
        assert_eq!(civil_from_unix(0), "1970-01-01");
        assert_eq!(civil_from_unix(951_782_400), "2000-02-29");
        assert_eq!(civil_from_unix(1_700_000_000), "2023-11-14");
    }
}
