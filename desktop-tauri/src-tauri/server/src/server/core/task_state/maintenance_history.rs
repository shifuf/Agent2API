use serde::{Deserialize, Serialize};

use super::TaskState;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    started_at: i64,
    finished_at: Option<i64>,
    status: Status,
    trigger: Trigger,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Status {
    Running,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Trigger {
    Manual,
    Scheduled,
}

pub(super) fn start(state: &mut TaskState, key: &str, manual: bool, now: i64) {
    use crate::server::config::{KEY_CREDENTIAL_MAINTENANCE, KEY_MODEL_REFRESH};
    if !matches!(key, KEY_CREDENTIAL_MAINTENANCE | KEY_MODEL_REFRESH)
        && !key.starts_with("pluginCatalog:")
    {
        return;
    }
    state.history.truncate(31);
    state.history.insert(
        0,
        Run {
            started_at: now,
            finished_at: None,
            status: Status::Running,
            trigger: if manual {
                Trigger::Manual
            } else {
                Trigger::Scheduled
            },
        },
    );
}

pub(super) fn finish(state: &mut TaskState, status: Status, now: i64) {
    if let Some(run) = state
        .history
        .first_mut()
        .filter(|run| run.status == Status::Running)
    {
        run.status = status;
        run.finished_at = Some(now.max(run.started_at));
    }
}

pub(super) fn recover(state: &mut TaskState, now: i64) {
    if state.lease_until <= now || state.owner.is_empty() {
        let at = if state.lease_until > 0 {
            state.lease_until
        } else {
            now
        };
        finish(state, Status::Interrupted, at);
    }
}

pub(super) fn expired(state: &TaskState, now: i64) -> bool {
    (state.lease_until <= now || state.owner.is_empty())
        && state
            .history
            .first()
            .is_some_and(|run| run.status == Status::Running)
}
