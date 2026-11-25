// The rules corpus's hand-written pieces (its README): the actor, the policy, the bodies, the
// hook and the event hook. Not compiled here: the service and transport probes include it.
use acme_purchasing_contract::operations::DecideBusinessError;
use acme_purchasing_service::{
    BodyError, Cx, Db, DecideAnswer, DecideMove, PurchasingBodies, PurchasingError, PurchasingEvents,
    PurchasingAfter, PurchasingHooks, PurchasingPolicy, PurchasingService, RequestTotalsAnswer, ServiceError,
    WriteEvent, WriteKind,
};
use meta_store::Query;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

/// The README's actor: a name and the permissions it holds.
struct Actor {
    name: String,
    grants: Vec<String>,
}

fn actor(name: &str, grants: &[&str]) -> Actor {
    Actor { name: name.to_string(), grants: grants.iter().map(|g| g.to_string()).collect() }
}

/// Allows a permission exactly when the actor holds it by name; no actor is refused.
struct Grants;

impl PurchasingPolicy<Actor, SqliteConnection> for Grants {
    async fn allows<'a>(
        &'a self,
        permission: acme_purchasing_rules::Permission,
        actor: Option<&'a Actor>,
        _row: Option<&'a Value>,
        _input: Option<&'a Value>,
        _conn: &'a mut SqliteConnection,
    ) -> Result<bool, PurchasingError> {
        Ok(actor.is_some_and(|a| a.grants.iter().any(|g| g == permission.name())))
    }
}

struct Bodies;

impl PurchasingBodies<Actor, SqliteConnection> for Bodies {
    async fn decide<'a>(
        &'a self,
        input: &'a acme_purchasing_contract::operations::DecideInput,
        _row: &'a acme_purchasing::PurchaseRequest,
        _cx: Cx<'a, Actor, SqliteConnection>,
    ) -> DecideAnswer {
        if !input.approve && input.note.as_deref().unwrap_or("").is_empty() {
            return Err(BodyError::Business(DecideBusinessError::NoteRequired));
        }
        Ok(if input.approve { DecideMove::Approve } else { DecideMove::Reject })
    }

    async fn request_totals<'a>(&'a self, cx: Cx<'a, Actor, SqliteConnection>) -> RequestTotalsAnswer {
        let rows = acme_purchasing_store::purchase_request::list(cx.conn, &Query::default()).await?;
        Ok(acme_purchasing::RequestTotals {
            count: Some(rows.len() as i64),
            total_cents: Some(rows.iter().map(|r| r.amount_cents).sum()),
        })
    }
}

/// Refuses a purchase request whose title is `REFUSE`, after it is updated.
struct Hooks;

impl PurchasingHooks<Actor, SqliteConnection> for Hooks {
    async fn after<'a>(
        &'a self,
        write: PurchasingAfter<'a>,
        _cx: Cx<'a, Actor, SqliteConnection>,
    ) -> Result<(), PurchasingError> {
        match write {
            PurchasingAfter::UpdatePurchaseRequest { row, .. } if row.title == "REFUSE" => {
                Err(ServiceError::refused("title_refused"))
            }
            _ => Ok(()),
        }
    }
}

/// Writes an audit entry for every write; refuses every write by `no-audit`.
struct Audit;

fn key_text(key: &Option<Value>) -> String {
    match key {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => "-".to_string(),
    }
}

impl PurchasingEvents<Actor, SqliteConnection> for Audit {
    async fn on_write<'a>(
        &'a self,
        event: &'a WriteEvent<'a, Actor>,
        conn: &'a mut SqliteConnection,
    ) -> Result<(), PurchasingError> {
        let by = event.actor.map_or("-", |a| a.name.as_str());
        if by == "no-audit" {
            return Err(ServiceError::refused("audit_unavailable"));
        }
        let key = key_text(&event.key);
        let detail = match event.kind {
            WriteKind::Transition => format!(
                "{} {key} {} {}->{} by {by}",
                event.entity.unwrap_or("-"),
                event.transition.unwrap_or("-"),
                event.from.as_deref().unwrap_or("-"),
                event.to.as_deref().unwrap_or("-"),
            ),
            WriteKind::Command => format!("{} {key} by {by}", event.operation.unwrap_or("-")),
            _ => format!("{} {key} by {by}", event.entity.unwrap_or("-")),
        };
        let entry: acme_purchasing::AuditEntryCreate =
            serde_json::from_value(json!({ "kind": event.kind.as_str(), "detail": detail })).unwrap();
        acme_purchasing_store::audit_entry::create(conn, &entry).await?;
        Ok(())
    }
}
