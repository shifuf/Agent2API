use std::collections::HashMap;
use std::sync::OnceLock;
use serde_json::Value;

use super::{cn_prices, peak, types::ModelPrice};
use crate::server::core::model_meta::snapshot::key_of;

pub fn bare_id(model: &str) -> String {
    model.trim().rsplit('/').next().unwrap_or_default().to_ascii_lowercase()
}

pub fn candidate_keys(model: &str) -> Vec<String> {
    let bare = bare_id(model);
    let mut keys = vec![model.trim().to_ascii_lowercase(), bare.clone(), key_of(&bare)];
    if let Some((name, suffix)) = bare.rsplit_once(['-', '_', '@']) {
        let date = if suffix.len() == 6 { format!("20{suffix}") } else { suffix.to_owned() };
        if date.len() == 8 && date.bytes().all(|byte| byte.is_ascii_digit()) && chrono::NaiveDate::parse_from_str(&date, "%Y%m%d").is_ok() { keys.push(key_of(name)); }
    }
    keys
}

fn model_prices() -> &'static HashMap<String, ModelPrice> {
    static PRICES: OnceLock<HashMap<String, ModelPrice>> = OnceLock::new();
    PRICES.get_or_init(|| {
        let snapshot: Value = serde_json::from_str(include_str!("usd_prices.json")).expect("bundled models.dev snapshot");
        snapshot["prices"].as_object().expect("bundled price table").iter()
            .filter_map(|(id, raw)| Some((id.clone(), ModelPrice::parse_json(raw, Some(id))?))).collect()
    })
}

pub fn provider_list_price(provider: &str, model: &str) -> Option<ModelPrice> {
    if cn_prices::is_domestic_cn_provider(provider) { cn_prices::lookup(model, Some(provider)) } else { None }
}

pub fn maker_list_price_for_provider(provider: Option<&str>, model: &str, peak_hint: Option<&str>) -> Option<ModelPrice> {
    if let Some(price) = provider.and_then(|id| provider_list_price(id, model)) { return Some(price); }
    let mut price = candidate_keys(model).iter().find_map(|key| model_prices().get(key))?.clone();
    price.apply_one_hour_for(model);
    if let Some(id) = peak_hint { price.peak = peak::peak_kind_for(id).into(); }
    Some(price)
}
