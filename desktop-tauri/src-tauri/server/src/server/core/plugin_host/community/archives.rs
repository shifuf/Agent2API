use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

const UNAVAILABLE: &str = "本机社区归档存储不可用";
const STALE: &str = "归档版本已变更，请重新查看后操作";

fn connect() -> Result<Connection, &'static str> {
    let connection = Connection::open(crate::paths::config_dir().join("community-archives.sqlite")).map_err(|_| UNAVAILABLE)?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS archives(name TEXT PRIMARY KEY, hash TEXT NOT NULL, metadata TEXT NOT NULL, body BLOB NOT NULL,
            previous_hash TEXT, previous_metadata TEXT, previous_body BLOB)").map_err(|_| UNAVAILABLE)?;
    Ok(connection)
}

pub(super) fn retain(bytes: &[u8], metadata: &mut Value, expected: Option<&str>) -> Result<(), &'static str> {
    let name = metadata["name"].as_str().ok_or(UNAVAILABLE)?;
    let hash = metadata["sha256"].as_str().ok_or(UNAVAILABLE)?;
    let mut connection = connect()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| UNAVAILABLE)?;
    let current: Option<String> = transaction.query_row("SELECT hash FROM archives WHERE name=?1", [name], |row| row.get(0)).optional().map_err(|_| UNAVAILABLE)?;
    if current.as_deref() != expected { return Err(STALE); }
    if current.as_deref() != Some(hash) {
        let (count, size): (i64, i64) = transaction.query_row("SELECT COUNT(*),COALESCE(SUM(length(body)+CASE WHEN name=?1 THEN 0 ELSE COALESCE(length(previous_body),0) END),0) FROM archives", [name], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| UNAVAILABLE)?;
        if (current.is_none() && count >= 32) || size + bytes.len() as i64 > 64 * 1024 * 1024 { return Err("本机社区归档已达上限"); }
        let encoded = serde_json::to_string(&metadata).map_err(|_| UNAVAILABLE)?;
        transaction.execute("INSERT INTO archives(name,hash,metadata,body) VALUES(?1,?2,?3,?4)
            ON CONFLICT(name) DO UPDATE SET previous_hash=hash,previous_metadata=metadata,previous_body=body,
                hash=excluded.hash,metadata=excluded.metadata,body=excluded.body", params![name, hash, encoded, bytes]).map_err(|_| UNAVAILABLE)?;
    }
    transaction.commit().map_err(|_| UNAVAILABLE)?;
    metadata["retained"] = json!(true);
    Ok(())
}

pub fn list() -> Result<Value, &'static str> {
    let connection = connect()?;
    let mut statement = connection.prepare("SELECT metadata,previous_hash FROM archives ORDER BY name").map_err(|_| UNAVAILABLE)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).map_err(|_| UNAVAILABLE)?;
    let mut items = Vec::new();
    for row in rows {
        let (metadata, previous) = row.map_err(|_| UNAVAILABLE)?;
        let mut item: Value = serde_json::from_str(&metadata).map_err(|_| UNAVAILABLE)?;
        item["previousSha256"] = json!(previous);
        item["retained"] = json!(true);
        items.push(item);
    }
    Ok(json!({"items":items,"executionAvailable":super::probe::available()}))
}

pub(super) fn read_current(name: &str, hash: &str) -> Result<Vec<u8>, (i32, &'static str)> {
    let db = Connection::open_with_flags(crate::paths::config_dir().join("community-archives.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| (409, STALE))?;
    db.query_row("SELECT body FROM archives WHERE name=?1 AND hash=?2 AND length(body)<=?3", params![name, hash, super::PACK_LIMIT as i64], |row| row.get(0))
        .optional().map_err(|_| (503, UNAVAILABLE))?.ok_or((409, STALE))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action { name: String, sha256: String, action: String }

pub fn change(action: Action) -> Result<Value, &'static str> {
    if !super::package_name(&action.name) { return Err("归档包名无效"); }
    let sql = match action.action.as_str() {
        "remove" => "DELETE FROM archives WHERE name=?1 AND hash=?2",
        "rollback" => "UPDATE archives SET hash=previous_hash,metadata=previous_metadata,body=previous_body,
            previous_hash=NULL,previous_metadata=NULL,previous_body=NULL WHERE name=?1 AND hash=?2 AND previous_hash IS NOT NULL",
        _ => return Err("未知的归档操作"),
    };
    let changed = connect()?.execute(sql, params![action.name, action.sha256]).map_err(|_| UNAVAILABLE)?;
    if changed != 1 { return Err(STALE); }
    Ok(json!({"changed":true}))
}
