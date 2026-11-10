//! Allowlisted coordination metadata. Never pass task records or diagnostic text here.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Principal {
    Source {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
    },
    LocalAuthority,
    Arc,
}
impl Principal {
    /// Project server-captured origin only. Null is unknown, never local authority.
    pub fn from_origin(origin: &Value) -> Result<Option<Self>> {
        if origin.is_null() {
            return Ok(None);
        }
        if origin["authType"] == "local"
            && matches!(string(origin, "ingressId"), "local-cli" | "local-ui")
        {
            return Ok(Some(Self::LocalAuthority));
        }
        let source_id = identifier(string(origin, "sourceId"))?;
        let account_id = origin["accountId"].as_str().map(identifier).transpose()?;
        Ok(Some(Self::Source {
            source_id,
            account_id,
        }))
    }
}

pub(crate) fn identifier(value: &str) -> Result<String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || matches!(value, "." | "..")
    {
        return Err("INVALID_ARGUMENT: expected an opaque coordination identifier".into());
    }
    Ok(value.into())
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ResourceKey(String);
impl From<ResourceKey> for String {
    fn from(key: ResourceKey) -> Self {
        key.0
    }
}
impl TryFrom<String> for ResourceKey {
    type Error = String;
    fn try_from(value: String) -> Result<Self> {
        if value == "unattributed:dispatch" {
            return Ok(Self::unattributed_dispatch());
        }
        Self::parse(&value)
    }
}
impl ResourceKey {
    /// Internal event marker. It carries no resource claim and is not admitted by parse.
    pub(crate) fn unattributed_dispatch() -> Self {
        Self("unattributed:dispatch".into())
    }
    pub(crate) fn is_claim(&self) -> bool {
        self.0 != "unattributed:dispatch"
    }
    pub fn parse(value: &str) -> Result<Self> {
        let valid = match value.split_once(':') {
            Some(("app", "installed")) => true,
            Some(("project", rest)) => rest
                .strip_suffix("/main")
                .is_some_and(|p| identifier(p).is_ok()),
            Some(("lane", rest)) => match rest.split_once('/') {
                Some((p, name)) => identifier(p).is_ok() && identifier(name).is_ok(),
                None => identifier(rest).is_ok(),
            },
            Some(("host" | "isolated", rest)) => identifier(rest).is_ok(),
            _ => false,
        };
        if !valid {
            let mut message = String::from("INVALID_ARGUMENT: use app:installed (example app:installed), project:<id>/main (example project:00000000-0000-4000-8000-000000000001/main), lane:<project>/<name> (example lane:00000000-0000-4000-8000-000000000001/worker), host:<id> (example host:server), or isolated:<id> (example isolated:preview). <id> in project keys and <project> in lane keys MUST be the registered project ID from query projects. Keys MUST match ARC-observed transition resources exactly for conflict detection. Event reads may use a unique retained lane:<name> shorthand (example lane:worker).");
            if let Some(("node" | "service" | "deployment" | "host", rest)) = value.split_once(':')
            {
                let host = rest.split('/').next().unwrap_or_default();
                if identifier(host).is_ok() {
                    message.push_str(&format!(
                        " For a host or service deployment, use host:{host}."
                    ));
                }
            }
            return Err(message);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn project(project_id: &str) -> Result<Self> {
        Self::parse(&format!("project:{}/main", identifier(project_id)?))
    }
    /// Producers resolve the parent from the registered project, never a personal path.
    pub fn lane(project_id: &str, name: &str) -> Result<Self> {
        Self::parse(&format!(
            "lane:{}/{}",
            identifier(project_id)?,
            identifier(name)?
        ))
    }
    pub(crate) fn shorthand(&self) -> Option<&str> {
        self.0.strip_prefix("lane:").filter(|v| !v.contains('/'))
    }
}

/// Resolve registered project names once at admission. Exact IDs take precedence.
pub fn canonical_resource(value: &str, registry: &Value) -> Result<ResourceKey> {
    let (selector, lane) = if let Some(project) = value
        .strip_prefix("project:")
        .and_then(|v| v.strip_suffix("/main"))
    {
        (project, None)
    } else if let Some((project, lane)) =
        value.strip_prefix("lane:").and_then(|v| v.split_once('/'))
    {
        (project, Some(lane))
    } else {
        return ResourceKey::parse(value);
    };
    let projects = registry["projects"].as_array().into_iter().flatten();
    let exact = projects.clone().find(|p| p["id"] == selector);
    let id = if let Some(project) = exact {
        string(project, "id")
    } else {
        let mut named = projects.filter(|p| p["name"] == selector);
        let project = named
            .next()
            .ok_or("RESOURCE_UNKNOWN: project is not registered; query projects for its ID")?;
        if named.next().is_some() {
            return Err(
                "RESOURCE_AMBIGUOUS: use the registered project ID from query projects".into(),
            );
        }
        string(project, "id")
    };
    match lane {
        Some(lane) => ResourceKey::lane(id, lane),
        None => ResourceKey::project(id),
    }
}

/// Pure admission projection shared by bulletin and message operations.
pub fn canonical_resources(args: &Value, registry: &Value) -> Result<Value> {
    let mut next = args.clone();
    if let Some(resources) = next.get_mut("resources").and_then(Value::as_array_mut) {
        for resource in resources {
            *resource = json!(canonical_resource(
                resource.as_str().unwrap_or(""),
                registry
            )?);
        }
    }
    for condition in next
        .get_mut("conditions")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        condition["resource"] = json!(canonical_resource(string(condition, "resource"), registry)?);
    }
    Ok(next)
}

pub(super) fn admit_resources(args: &mut Value) -> Result<()> {
    if !args["resources"].as_array().is_some_and(|resources| {
        resources.iter().any(|r| {
            r.as_str()
                .is_some_and(|r| r.starts_with("project:") || r.starts_with("lane:"))
        })
    }) {
        return Ok(());
    }
    let registry = crate::kernel::file_cache::load(&root().join("coordination/projects.json"))
        .unwrap_or(Value::Null);
    *args = canonical_resources(args, &registry)?;
    Ok(())
}

/// A projection of registered project/lane identities, not a second registry.
#[derive(Default)]
pub struct Resources {
    projects: BTreeSet<String>,
    lanes: BTreeSet<ResourceKey>,
}
impl Resources {
    pub fn project(&mut self, project_id: &str) -> Result<ResourceKey> {
        let key = ResourceKey::project(project_id)?;
        self.projects.insert(project_id.into());
        Ok(key)
    }
    pub fn lane(&mut self, project_id: &str, name: &str) -> Result<ResourceKey> {
        if !self.projects.contains(project_id) {
            return Err("RESOURCE_UNKNOWN: resolve the registered parent project first".into());
        }
        let key = ResourceKey::lane(project_id, name)?;
        self.lanes.insert(key.clone());
        Ok(key)
    }
    pub fn resolve(&self, value: &str) -> Result<ResourceKey> {
        let key = resolve_resource(value, self.lanes.iter())?;
        if let Some(project) = key
            .as_str()
            .strip_prefix("project:")
            .and_then(|p| p.strip_suffix("/main"))
        {
            if !self.projects.contains(project) {
                return Err("RESOURCE_UNKNOWN: project is not registered".into());
            }
        }
        if key.as_str().starts_with("lane:") && !self.lanes.contains(&key) {
            return Err("RESOURCE_UNKNOWN: lane has no registered parent association".into());
        }
        Ok(key)
    }
}
pub(crate) fn resolve_resource<'a>(
    value: &str,
    keys: impl Iterator<Item = &'a ResourceKey>,
) -> Result<ResourceKey> {
    let key = ResourceKey::parse(value)?;
    let Some(name) = key.shorthand() else {
        return Ok(key);
    };
    let choices: BTreeSet<_> = keys
        .filter(|key| key.0.starts_with("lane:") && key.0.ends_with(&format!("/{name}")))
        .take(17)
        .cloned()
        .collect();
    if choices.len() == 1 {
        return Ok(choices.into_iter().next().unwrap());
    }
    Err(if choices.is_empty() {
        "RESOURCE_UNKNOWN: use a qualified lane:<project>/<name> key".into()
    } else {
        format!(
            "RESOURCE_AMBIGUOUS: use one of {}",
            choices
                .into_iter()
                .take(16)
                .map(|key| key.0)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum EventKind {
    #[serde(rename = "message.created")]
    MessageCreated,
    #[serde(rename = "message.delivery")]
    MessageDelivery,
    #[serde(rename = "negotiation.changed")]
    NegotiationChanged,
    #[serde(rename = "dispatch.accepted")]
    DispatchAccepted,
    #[serde(rename = "receipt.unconfirmed")]
    ReceiptUnconfirmed,
    #[serde(rename = "lane.created")]
    LaneCreated,
    #[serde(rename = "lane.landed")]
    LaneLanded,
    #[serde(rename = "lane.removed")]
    LaneRemoved,
    #[serde(rename = "isolated.started")]
    IsolatedStarted,
    #[serde(rename = "isolated.exited")]
    IsolatedExited,
    #[serde(rename = "turn.terminal")]
    TurnTerminal,
    #[serde(rename = "turn.successor")]
    TurnSuccessor,
    #[serde(rename = "app.replace")]
    AppReplace,
    #[serde(rename = "app.restarted")]
    AppRestarted,
    #[serde(rename = "git.ref-moved")]
    GitRefMoved,
    #[serde(rename = "notification.delivery-failed")]
    NotificationDeliveryFailed,
    #[serde(rename = "receipt.stalled")]
    ReceiptStalled,
    #[serde(rename = "ax.created")]
    AxCreated,
    #[serde(rename = "ax.changed")]
    AxChanged,
    #[serde(rename = "notice.changed")]
    NoticeChanged,
    #[serde(rename = "blocker.changed")]
    BlockerChanged,
}
impl EventKind {
    fn summary(&self) -> &'static str {
        match self {
            Self::ReceiptUnconfirmed => "Receipt ended unconfirmed",
            Self::LaneCreated => "Lane created",
            Self::LaneLanded => "Lane landed",
            Self::LaneRemoved => "Lane removed",
            Self::IsolatedStarted => "Isolated supervisor started",
            Self::IsolatedExited => "Isolated supervisor exited",
            Self::DispatchAccepted => "Dispatch accepted",
            Self::TurnTerminal => "Turn reached a terminal state",
            Self::TurnSuccessor => "Successor turn observed",
            Self::AppReplace => "Application replacement state changed",
            Self::AppRestarted => "ARC instance restarted",
            Self::GitRefMoved => "Registered Git ref changed",
            Self::NotificationDeliveryFailed => "Notification delivery attempt failed",
            Self::ReceiptStalled => "Receipt progress stalled",
            Self::MessageCreated => "Coordination message created",
            Self::MessageDelivery => "Coordination message delivery changed",
            Self::NegotiationChanged => "Coordination negotiation state changed",
            Self::AxCreated => "AX entry created",
            Self::AxChanged => "AX entry changed",
            Self::NoticeChanged => "Notice state changed",
            Self::BlockerChanged => "Blocker state changed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventStatus {
    Active,
    Uncertain,
    Stale,
    Cleared,
    Withdrawn,
    Accepted,
    Cancelled,
    Settling,
    RecoverySummary,
    Unconfirmed,
    Submitted,
    Running,
    Completed,
    Failed,
    Interrupted,
    RolledBack,
    Succeeded,
    Unknown,
    Candidate,
    Open,
    Triaged,
    Closed,
    Merged,
    Rejected,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeBasis {
    Observed,
    Upstream,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttributionConfidence {
    Correlated,
    Ambiguous,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribution {
    pub confidence: AttributionConfidence,
    pub thread_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRef {
    pub thread_id: String,
    pub turn_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    Notice,
    Blocker,
    Receipt,
    Request,
    Thread,
    Turn,
    Dispatch,
    Replacement,
    Ax,
    GitObject,
    GitRef,
    CoreInstance,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRef {
    pub kind: EvidenceKind,
    pub id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchAssociation {
    pub resources: Vec<ResourceKey>,
    pub project: String,
    pub lane: String,
    pub source: String,
    pub session: String,
    pub registry_observed_at: Option<String>,
}

/// Typed observation details. No diagnostic strings or task content are accepted.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_association: Option<DispatchAssociation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_binding_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_submissions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub movement: Option<RefMovement>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefMovement {
    Created,
    Moved,
    Deleted,
    NonFastForward,
    Unknown,
}

/// Internal-only input. Persist this descriptor with the owner's stable transition ID
/// BEFORE emit. No prompt/title/error/summary or arbitrary JSON field is accepted.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    pub transition_id: String,
    pub kind: EventKind,
    pub resources: Vec<ResourceKey>,
    pub origin: Option<Principal>,
    pub occurred_at: Option<String>,
    pub status: Option<EventStatus>,
    #[serde(default)]
    pub thread_refs: Vec<ThreadRef>,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    pub attribution: Option<Attribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
}
impl EventInput {
    pub fn new(transition_id: String, kind: EventKind, resources: Vec<ResourceKey>) -> Self {
        Self {
            transition_id,
            kind,
            resources,
            origin: None,
            occurred_at: None,
            status: None,
            thread_refs: vec![],
            evidence_refs: vec![],
            attribution: None,
            observation: None,
        }
    }
    pub(crate) fn project(&self, epoch: &str, sequence: u64, time: i64) -> Result<Value> {
        identifier(&self.transition_id)?;
        if chrono::DateTime::from_timestamp_millis(time).is_none() {
            return Err("INVALID_ARGUMENT: observed time is out of range".into());
        }
        if self.resources.is_empty()
            || self.resources.len() > 16
            || self.thread_refs.len() > 16
            || self.evidence_refs.len() > 16
        {
            return Err("COORDINATION_CAPACITY: metadata arrays exceed their bounds".into());
        }
        if self.resources.iter().any(|r| r.shorthand().is_some()) {
            return Err(
                "INVALID_ARGUMENT: producers must qualify lanes with their registered parent"
                    .into(),
            );
        }
        if let Some(Principal::Source {
            source_id,
            account_id,
        }) = &self.origin
        {
            identifier(source_id)?;
            if let Some(account) = account_id {
                identifier(account)?;
            }
        }
        for thread in &self.thread_refs {
            identifier(&thread.thread_id)?;
            if let Some(turn) = &thread.turn_id {
                identifier(turn)?;
            }
        }
        for evidence in &self.evidence_refs {
            identifier(&evidence.id)?;
        }
        if let Some(attribution) = &self.attribution {
            if attribution.thread_ids.len() > 16 {
                return Err("COORDINATION_CAPACITY: attribution exceeds 16 threads".into());
            }
            for thread in &attribution.thread_ids {
                identifier(thread)?;
            }
        }
        if let Some(time) = &self.occurred_at {
            chrono::DateTime::parse_from_rfc3339(time)
                .map_err(|_| "INVALID_ARGUMENT: occurredAt must be RFC3339")?;
        }
        if let Some(detail) = &self.observation {
            for session in [&detail.session_id, &detail.session_binding_id]
                .into_iter()
                .flatten()
            {
                identifier(session)?;
            }
            for value in [&detail.model, &detail.effort].into_iter().flatten() {
                if value.len() > 128
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
                {
                    return Err("INVALID_ARGUMENT: invalid model or effort metadata".into());
                }
            }
            for oid in [&detail.old_oid, &detail.new_oid].into_iter().flatten() {
                if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("INVALID_ARGUMENT: invalid Git object ID".into());
                }
            }
        }
        Ok(
            json!({"eventId":hash(format!("{epoch}:{}",self.transition_id)),"sequence":sequence,
            "kind":self.kind,"provenance":"arc-observed","resources":self.resources,
            "observedAt":timestamp(time),"occurredAt":self.occurred_at,
            "timeBasis":if self.occurred_at.is_some() {TimeBasis::Upstream} else {TimeBasis::Observed},
            "origin":self.origin,"threadRefs":self.thread_refs,"summary":self.kind.summary(),
            "evidenceRefs":self.evidence_refs,"status":self.status,"observation":self.observation,
            "attribution":self.attribution.as_ref().map(|a|json!({"basis":"turn-baseline","confidence":a.confidence,"threadIds":a.thread_ids}))}),
        )
    }
}
pub(crate) fn timestamp(time: i64) -> String {
    chrono::DateTime::from_timestamp_millis(time)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
