//! Bounded network transport shared with the embedded WASM host.
//! Script package installation and Bun are intentionally outside this module.
pub(super) mod transport;
mod protocol;
mod managed_http;
mod websocket;
pub(super) mod trace;

pub(super) use websocket::{abort as abort_ws, open as open_ws, read as read_ws, send as send_ws};
pub(super) use transport::{close as close_http, open_body, read as read_http, resolve_proxy, RequestBody};
pub(super) use trace::register as register_trace;
pub(super) use transport::convert as convert_request;
pub(super) use protocol::{open as open_stream, push as push_stream, close as close_stream};
pub(super) use managed_http::{open_body_with_policy, HttpDeadline, HttpHandle};
