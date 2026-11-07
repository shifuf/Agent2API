//! Public catalog candidates for the model editor. Both routes stay on the
//! authenticated management API and never mutate managed models or channels.

use crate::server::{core::public_model_catalog, errors::management_error, http::ok_json};
use axum::response::Response;

pub async fn get_catalog() -> Response {
    respond(false).await
}

pub async fn refresh_catalog() -> Response {
    respond(true).await
}

async fn respond(force: bool) -> Response {
    match public_model_catalog::snapshot(force).await {
        Ok(snapshot) => ok_json(serde_json::json!(snapshot)),
        Err(error) => management_error(502, error),
    }
}
