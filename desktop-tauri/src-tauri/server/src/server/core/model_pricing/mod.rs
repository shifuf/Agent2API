pub mod calc;
mod catalog;
mod cn_prices;
pub mod fx;
mod peak;
mod types;

pub use types::{ModelPricingSettings, KEY_MODEL_PRICING};
use crate::server::config;

pub fn settings() -> ModelPricingSettings {
    config::with_raw(|raw| raw.get(KEY_MODEL_PRICING).and_then(|value| serde_json::from_value(value.clone()).ok())).flatten().unwrap_or_default()
}

pub fn display_currency() -> &'static str {
    if config::with_raw(|raw| raw.get(KEY_MODEL_PRICING).and_then(|item| item.get("currency")).and_then(serde_json::Value::as_str) == Some("cny")) == Some(true) { "cny" } else { "usd" }
}
