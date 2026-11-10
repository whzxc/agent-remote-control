//! Private front-door/Core protocol. These types do not change any public wire schema.
use crate::*;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const VERSION: u16 = 1;
pub(crate) const MAX_REQUEST_BYTES: usize = 36 * 1024 * 1024;
pub(crate) const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_IN_FLIGHT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Generation(pub [u8; 16]);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Readiness {
    Ready,
    Draining,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Hello {
    pub version: u16,
    pub generation: Generation,
    pub readiness: Readiness,
    pub max_request_bytes: usize,
    pub max_frame_bytes: usize,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) struct Deadline {
    unix_ms: u64,
}
impl Deadline {
    pub fn after(duration: Duration) -> Self {
        Self {
            unix_ms: unix_ms().saturating_add(duration.as_millis() as u64),
        }
    }
    pub fn remaining(self) -> Result<Duration> {
        let remaining = self.unix_ms.saturating_sub(unix_ms());
        if remaining == 0 {
            Err("FRONT_DOOR_DEADLINE_EXPIRED: Read current state before retrying a write.".into())
        } else {
            Ok(Duration::from_millis(remaining))
        }
    }
}
fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RequestId(pub String);
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) enum Operation {
    Mcp,
    LocalControl,
    Management { route: String, method: String },
    Snapshot { kind: Snapshot },
    Health,
    Authority { op: String },
    IngressContext { ingress_id: String },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) enum Snapshot {
    Status,
    Browser,
    Subscriptions,
    Activity,
}

// Decode context only after authenticating the private peer. Public headers cannot mint authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AuthenticatedContext {
    pub(super) authority: Authority,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) enum Authority {
    Management,
    Browser {
        ingress_id: String,
        key_digest: String,
    },
    Mcp {
        ingress_id: String,
        source_id: String,
        credential: Value,
        origin: Value,
    },
}
impl AuthenticatedContext {
    pub(crate) fn validate(&self) -> Result<()> {
        match &self.authority {
            Authority::Mcp {
                ingress_id,
                source_id,
                credential,
                ..
            } => {
                let source = crate::sources::authority(source_id)?;
                if source["state"] == "revoked"
                    || source["connectionRemoved"] == true
                    || source["ingressId"] != *ingress_id
                    || source["credential"] != *credential
                {
                    return Err(crate::sources::authorization_error(&source));
                }
            }
            Authority::Browser { key_digest, .. } => {
                if crate::browser::key_digest().as_ref() != Some(key_digest) {
                    return Err("FRONT_DOOR_BROWSER_UNAUTHORIZED".into());
                }
            }
            Authority::Management => {}
        }
        Ok(())
    }
    pub(crate) fn origin(&self) -> Option<&Value> {
        match &self.authority {
            Authority::Mcp { origin, .. } => Some(origin),
            _ => None,
        }
    }
    pub(crate) fn ingress_id(&self) -> Option<&str> {
        match &self.authority {
            Authority::Mcp { ingress_id, .. } | Authority::Browser { ingress_id, .. } => {
                Some(ingress_id)
            }
            _ => None,
        }
    }
    pub(crate) fn is_management(&self) -> bool {
        matches!(self.authority, Authority::Management)
    }
    pub(crate) fn is_browser(&self) -> bool {
        matches!(self.authority, Authority::Browser { .. })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Request {
    pub version: u16,
    pub generation: Generation,
    pub id: RequestId,
    pub deadline: Deadline,
    pub context: AuthenticatedContext,
    pub operation: Operation,
    pub body: Value,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        self.deadline.remaining()?;
        bounded(self, MAX_REQUEST_BYTES)?;
        self.context.validate()
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ResponseFrame {
    pub generation: Generation,
    pub request_id: RequestId,
    pub body: Result<Value>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct StreamFrame {
    pub generation: Generation,
    pub request_id: RequestId,
    pub sequence: u64,
    pub body: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Cancellation {
    pub generation: Generation,
    pub request_id: RequestId,
}
#[allow(dead_code)] // The process-swap owner will consume drain acknowledgements.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DrainAck {
    pub generation: Generation,
    pub outstanding: usize,
}
pub(crate) fn fence(current: Generation, tagged: Generation) -> Result<()> {
    if current != tagged {
        Err("FRONT_DOOR_STALE_GENERATION: Response discarded; read current state before retrying a write.".into())
    } else {
        Ok(())
    }
}
pub(crate) fn bounded(value: &impl Serialize, limit: usize) -> Result<()> {
    // Count without allocating a second serialized frame or retaining an oversized body.
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self.bytes.saturating_add(bytes.len());
            if self.bytes > self.limit {
                return Err(std::io::Error::other("frame too large"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Counter { bytes: 0, limit }, value).map_err(|_| {
        "FRONT_DOOR_FRAME_TOO_LARGE: Reduce the request or read a smaller result page.".into()
    })
}
