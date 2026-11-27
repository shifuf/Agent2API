//! New API 订阅扣费偏好及额度，适配自 aimod-cc/Agent2API 091ac96c（Lucas）。

use std::time::Duration;

use serde_json::{json, Value};

use super::balance_parse::{new_api_display_amount, new_api_document, number_of, unix_to_ms, QuotaDisplay};
use crate::server::errors::GatewayError;

pub(super) async fn get_json(
    client: &reqwest::Client, url: &str, headers: &[(String, String)], label: &str,
) -> Result<Value, GatewayError> {
    let mut request = client.get(url).timeout(Duration::from_secs(20));
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let failure = || GatewayError::with_status(502, format!("{label} 的余额请求失败"));
    let mut response = request.send().await.map_err(|_| failure())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let code = if matches!(status, 401 | 403) { i32::from(status) } else { 502 };
        return Err(GatewayError::with_status(code, format!("{label} 的余额查询被上游拒绝（HTTP {status}）")));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err(failure()); }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| failure())?;
    if payload.get("success").and_then(Value::as_bool) == Some(false) { return Err(failure()); }
    Ok(payload)
}

pub(super) fn report(
    wallet: f64, used: Option<f64>, display: Option<&QuotaDisplay>, payload: Option<&Value>, now_ms: i64,
) -> Value {
    let mut report = new_api_document(wallet, used, display);
    let Some(root) = payload else { return report };
    let data = root.get("data").unwrap_or(root);
    let items = if let Some(items) = data.as_array() { items.as_slice() }
        else if let Some(rows) = data.get("subscriptions").or_else(|| data.get("items")).or_else(|| data.get("list")) {
            let Some(rows) = rows.as_array() else { return report };
            rows.as_slice()
        } else if data.get("subscription").is_some() || data.get("amount_total").is_some() || data.get("amount_used").is_some() {
            std::slice::from_ref(data)
        } else { return report };
    let mut count = 0;
    let mut remaining_sum = Some(0.0);
    let mut total_sum = Some(0.0);
    let mut used_sum = Some(0.0);
    let mut unlimited = false;
    let mut allow_overflow = true;
    let mut names = Vec::new();
    let mut reset_at: Option<i64> = None;
    let mut expires_at: Option<i64> = None;
    for item in items {
        let sub = item.get("subscription").unwrap_or(item);
        if !sub.is_object() || sub.get("status").and_then(Value::as_str)
            .is_some_and(|status| !status.trim().is_empty() && !status.trim().eq_ignore_ascii_case("active")) { continue; }
        let expiry = unix_to_ms(sub.get("end_time"));
        if expiry.is_some_and(|end| end <= now_ms) { continue; }
        if sub.get("amount_total").is_none() && sub.get("amount_used").is_none() { continue; }
        count += 1;
        let total = number_of(sub.get("amount_total")).filter(|amount| *amount >= 0.0);
        let used_amount = number_of(sub.get("amount_used")).filter(|amount| *amount >= 0.0);
        unlimited |= total == Some(0.0);
        total_sum = total_sum.zip(total).map(|(sum, amount)| sum + amount);
        used_sum = used_sum.zip(used_amount).map(|(sum, amount)| sum + amount);
        remaining_sum = remaining_sum.zip(total.zip(used_amount))
            .map(|(sum, (quota, consumed))| sum + (quota - consumed).max(0.0));
        allow_overflow &= sub.get("allow_wallet_overflow").and_then(Value::as_bool) != Some(false);
        if let Some(reset) = unix_to_ms(sub.get("next_reset_time")).filter(|reset| *reset > now_ms) {
            reset_at = Some(reset_at.map_or(reset, |existing| existing.min(reset)));
        }
        if let Some(end) = expiry { expires_at = Some(expires_at.map_or(end, |existing| existing.max(end))); }
        let plan = item.get("plan").or_else(|| sub.get("plan"));
        if let Some(name) = plan.and_then(|plan| plan.get("title").or_else(|| plan.get("name")))
            .or_else(|| sub.get("plan_title")).or_else(|| sub.get("plan_name"))
            .and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) {
            if !names.contains(&name) { names.push(name); }
        }
    }
    if count == 0 { return report; }
    let preference = data.get("billing_preference").and_then(Value::as_str).unwrap_or_default().trim().to_ascii_lowercase();
    let (preference, use_plan, use_wallet) = match preference.as_str() {
        "wallet_only" => ("wallet_only", false, true),
        "subscription_only" => ("subscription_only", true, false),
        "wallet_first" => ("wallet_first", true, true),
        _ => ("subscription_first", true, allow_overflow),
    };
    let amount = |raw: f64| new_api_display_amount(raw, display).0;
    let available = if !use_plan { Some(wallet) } else if unlimited { None } else {
        remaining_sum.map(|remaining| remaining + if use_wallet { wallet.max(0.0) } else { 0.0 })
    };
    report["available"] = json!(available.map(amount));
    if use_plan && unlimited {
        report["unlimited"] = json!(true);
        report["availableView"] = json!("∞");
    } else if available.is_none() {
        report["availableView"] = json!("—");
    }
    let mut subscription = json!({"count": count, "billingPreference": preference});
    let mut line = json!({"type": "subscription", "displayName": "订阅额度", "unit": report["unit"]});
    if !names.is_empty() { subscription["planName"] = json!(names.join(" / ")); }
    if let Some(reset) = reset_at { subscription["resetsAt"] = json!(reset); line["resetsAt"] = json!(reset); }
    if let Some(end) = expires_at { subscription["expireAt"] = json!(end); }
    if unlimited {
        subscription["unlimited"] = json!(true);
        line["unlimited"] = json!(true);
        line["balanceView"] = json!("∞");
    } else {
        if let Some(remaining) = remaining_sum.map(amount) {
            subscription["remainQuota"] = json!(remaining);
            line["balance"] = json!(remaining);
        }
        if let Some(total) = total_sum.map(amount) { subscription["totalQuota"] = json!(total); }
    }
    if let Some(used) = used_sum.map(amount) { line["used"] = json!(used); }
    if let Some(wallets) = report["wallets"].as_array_mut() { wallets.push(line); }
    report["subscription"] = subscription;
    report["billingPreference"] = json!(preference);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_active_rows_and_explicit_zero_have_distinct_totals() {
        let data = json!({"data": {"subscriptions": [
            {"subscription": {"amount_total": 10, "amount_used": 10}},
            {"subscription": {"amount_used": 1}}
        ], "billing_preference": "subscription_only"}});
        let unknown = report(3.0, None, None, Some(&data), 1);
        assert_eq!(unknown["available"], Value::Null);
        assert!(unknown["subscription"].get("remainQuota").is_none());
        assert!(unknown["subscription"].get("totalQuota").is_none());
        let empty = report(3.0, None, None, Some(&json!({"amount_total": 10, "amount_used": 10, "allow_wallet_overflow": false})), 1);
        assert_eq!(empty["available"], 0.0);
        assert_eq!(empty["subscription"]["remainQuota"], 0.0);
    }

    #[test]
    fn flat_subscription_arrays_filter_expired_and_choose_next_reset() {
        let data = json!({"data": [
            {"amount_total": "100", "amount_used": 12, "next_reset_time": 9, "end_time": 10},
            {"amount_total": 4, "amount_used": 1, "next_reset_time": 1, "end_time": 7},
            {"amount_total": 20, "amount_used": 3, "end_time": 2},
            {"amount_total": 40, "status": "cancelled"}
        ]});
        let value = report(4.0, None, None, Some(&data), 3000);
        assert_eq!(value["available"], 95.0);
        assert_eq!(value["subscription"]["resetsAt"], 9000);
        assert_eq!(value["subscription"]["expireAt"], 10000);
        assert_eq!(value["subscription"]["count"], 2);
    }
}
