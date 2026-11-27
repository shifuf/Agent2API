use rusqlite::{params, Row};
use serde_json::{json, Value};

use super::{clock, RequestStats};
use crate::server::{core::model_pricing, logging};

pub enum Selection {
    Id(String),
    Period { from_ms: i64, to_ms: i64 },
}

struct Sample {
    row_id: i64,
    id: String,
    ts: i64,
    provider: String,
    model: String,
    upstream_model: String,
    output: i64,
    read: i64,
    test: bool,
    old_usd: Option<f64>,
    raw: Option<String>,
}

impl Sample {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            row_id: row.get(0)?, id: row.get(1)?, ts: row.get(2)?, provider: row.get(3)?,
            model: row.get(4)?, upstream_model: row.get(5)?, output: row.get(6)?,
            read: row.get(7)?, test: row.get(8)?, old_usd: row.get(9)?, raw: row.get(10)?,
        })
    }
}

impl RequestStats {
    pub fn reprice(&self, selection: Selection) -> Result<Value, (i32, &'static str)> {
        const FIELDS: &str = "row_id,id,ts,provider,model,upstream_model,completion_tokens,cache_read_tokens,is_test,cost_usd,pricing_evidence";
        const MAX_ROWS: usize = 2000;
        let settings = model_pricing::settings();
        let guard = self.guard();
        let samples = self.with_conn(&guard, |conn| {
            let (query, bindings) = match &selection {
                Selection::Id(id) => (format!("SELECT {FIELDS} FROM requests WHERE id=?1 AND status<>0 ORDER BY row_id DESC LIMIT 1"), vec![rusqlite::types::Value::from(id.clone())]),
                Selection::Period { from_ms, to_ms } => (format!("SELECT {FIELDS} FROM requests WHERE ts>=?1 AND ts<?2 AND status<>0 LIMIT ?3"), vec![(*from_ms).into(), (*to_ms).into(), (MAX_ROWS as i64 + 1).into()]),
            };
            let mut stmt = conn.prepare(&query)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(bindings), Sample::read)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }).ok_or((503, "无法读取请求记录"))?;
        if samples.len() > MAX_ROWS { return Err((422, "时间段内超过 2000 条请求；请缩小范围")); }
        let single = matches!(selection, Selection::Id(_));
        if single && samples.is_empty() { return Err((404, "请求记录不存在")); }
        let count = samples.len();
        let mut updates = Vec::new();
        let mut response = Value::Null;
        let timestamp = logging::now_ms();
        for sample in samples {
            let mut evidence: Value = sample.raw.as_deref().and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
            let Some(prompt) = evidence["prompt"].as_i64() else { continue };
            let Some(detail) = model_pricing::calc::calc_request_cost_detail(&settings, &sample.provider, &sample.model, &sample.upstream_model, sample.ts, prompt, sample.output, sample.read, evidence["cacheWrite"].as_i64().unwrap_or(0), evidence["cacheWrite1h"].as_i64().unwrap_or(0)).flatten() else { continue };
            let old_cny = match sample.old_usd {
                Some(old) => match evidence.pointer("/quote/fx/rate").and_then(Value::as_f64).map(|rate| rate * old).filter(|amount| amount.is_finite()) { Some(amount) => amount, None => continue },
                None => 0.0,
            };
            let Some(cny) = detail.evidence.pointer("/fx/rate").and_then(Value::as_f64).map(|rate| rate * detail.cost_usd).filter(|amount| amount.is_finite()) else { continue };
            evidence["quote"] = detail.evidence;
            evidence["repricedAt"] = json!(timestamp);
            let date = evidence["date"].as_str().map(str::to_owned).unwrap_or_else(|| clock::date_key(clock::day_of(sample.ts)));
            if single { response = json!({"id":sample.id,"costUsd":detail.cost_usd,"costCny":cny}); }
            updates.push((sample, evidence, detail.cost_usd, cny - old_cny, date));
        }
        if single && updates.is_empty() { return Err((409, "无可验证用量或单价，保留原估价")); }
        let applied = self.with_conn_mut(&guard, |conn| {
            let transaction = conn.transaction()?;
            for (sample, evidence, usd, cny_delta, date) in &updates {
                let written = transaction.execute("UPDATE requests SET cost_usd=?1, pricing_evidence=?2 WHERE row_id=?3 AND id=?4 AND ts=?5 AND pricing_evidence IS ?6 AND cost_usd IS ?7", params![usd, serde_json::to_string(evidence).expect("JSON value"), sample.row_id, sample.id, sample.ts, sample.raw, sample.old_usd])?;
                if written != 1 { return Ok(false); }
                if !sample.test {
                    transaction.execute("UPDATE request_daily SET cost_usd=MAX(0,cost_usd+?1), cost_cny=MAX(0,cost_cny+?2), priced_requests=priced_requests+?3 WHERE date=?4", params![usd - sample.old_usd.unwrap_or(0.0), cny_delta, i64::from(sample.old_usd.is_none()), date])?;
                }
            }
            transaction.commit()?;
            Ok(true)
        }).ok_or((503, "计价事务未能写入"))?;
        if !applied { return Err((409, "请求记录已更改，请刷新")); }
        Ok(if single { response } else { json!({"updated":updates.len(),"skipped":count - updates.len()}) })
    }
}
