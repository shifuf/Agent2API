use crate::server::{
    core::managed_models::{self, BatchAction, ManagedModel},
    errors::management_error,
    http::ok_json,
    ServerState,
};
use axum::{body::Bytes, extract::State, response::Response};
use serde::Deserialize;

pub async fn get_catalog(State(state): State<ServerState>) -> Response {
    match managed_models::management(state.store()) {
        Ok(data) => ok_json(data),
        Err(error) => management_error(400, error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveModel {
    #[serde(default)]
    previous_id: String,
    model: Option<ManagedModel>,
    revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchModels {
    action: BatchAction,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    models: Vec<ManagedModel>,
    revision: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SaveRequest {
    Batch(BatchModels),
    Single(SaveModel),
}

pub async fn save_model(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload: SaveRequest = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return management_error(400, "模型配置格式无效"),
    };
    let result = match payload {
        SaveRequest::Batch(payload) => managed_models::batch(
            payload.action,
            &payload.ids,
            payload.models,
            &payload.revision,
        ),
        SaveRequest::Single(payload) => {
            if payload.model.is_none() && payload.previous_id.is_empty() {
                return management_error(400, "请选择要删除的模型");
            }
            managed_models::save(&payload.previous_id, payload.model, &payload.revision)
        }
    };
    match result {
        Ok(()) => get_catalog(State(state)).await,
        Err(error) => management_error(400, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_and_legacy_payloads_cannot_be_mixed() {
        let legacy = r#"{"previousId":"old","model":{"id":"old","enabled":true,"bindings":[]},"revision":"revision"}"#;
        assert!(matches!(
            serde_json::from_str::<SaveRequest>(legacy),
            Ok(SaveRequest::Single(_))
        ));
        let batch =
            r#"{"action":"create","models":[{"id":"new","bindings":[]}],"revision":"revision"}"#;
        assert!(matches!(
            serde_json::from_str::<SaveRequest>(batch),
            Ok(SaveRequest::Batch(_))
        ));
        for invalid in [
            r#"{"action":"delete","ids":["old"],"previousId":"other","revision":"revision"}"#,
            r#"{"action":"create","models":[],"model":{"id":"other"},"revision":"revision"}"#,
            r#"{"action":"unknown","ids":["old"],"revision":"revision"}"#,
            r#"{"action":"delete","ids":["old"]}"#,
        ] {
            assert!(serde_json::from_str::<SaveRequest>(invalid).is_err());
        }
    }
}
