//! Captures the selected egress once for a fixed host operation.
//! Explicit proxy failure is an error; the client has no redirect or direct retry path.
use crate::server::core::{egress, proxies::ResolvedProxy};

#[derive(Clone)]
pub(crate) struct FrozenHttpClient { client: reqwest::Client, _selected: Option<ResolvedProxy> }

impl FrozenHttpClient {
    pub async fn from_selected(selected: Option<ResolvedProxy>) -> Result<Self, String> {
        let client = egress::resolved_client(selected.as_ref(), false, "", &[])?;
        Ok(Self { client, _selected: selected })
    }
    pub fn client(&self) -> Result<reqwest::Client, String> { Ok(self.client.clone()) }
}
