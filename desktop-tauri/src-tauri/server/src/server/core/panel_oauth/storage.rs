use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

pub const KEY_PANEL_OAUTH: &str = "panelOauthExternal";

pub(crate) fn migrate_legacy_storage(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("SAVEPOINT panel_oauth_external_migration")?;
    let result = migrate_slot(conn);
    match result {
        Ok(()) => conn.execute_batch("RELEASE SAVEPOINT panel_oauth_external_migration"),
        Err(error) => {
            conn.execute_batch("ROLLBACK TO SAVEPOINT panel_oauth_external_migration; RELEASE SAVEPOINT panel_oauth_external_migration")?;
            Err(error)
        }
    }
}

fn migrate_slot(conn: &Connection) -> rusqlite::Result<()> {
    let current: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1)",
        [KEY_PANEL_OAUTH],
        |row| row.get(0),
    )?;
    if !current {
        let previous: Option<String> = conn.query_row(
            "SELECT value FROM kv WHERE key='panelOauth'",
            [],
            |row| row.get(0),
        ).optional()?;
        if let Some(previous) = previous.filter(|text| {
            serde_json::from_str::<Value>(text).is_ok_and(|value| {
                value.get("settingsEnc").is_none()
                    && value.get("publicBaseUrl").is_some_and(Value::is_string)
                    && ["google", "github"].iter().any(|key| value.get(*key).is_some_and(Value::is_object))
            })
        }) {
            conn.execute("INSERT INTO kv(key,value) VALUES (?1,?2)", rusqlite::params![KEY_PANEL_OAUTH, previous])?;
            conn.execute("DELETE FROM kv WHERE key='panelOauth'", [])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)").unwrap();
        conn
    }

    fn read(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row("SELECT value FROM kv WHERE key=?1", [key], |row| row.get(0)).optional().unwrap()
    }

    #[test]
    fn migrates_only_upstream_shape_and_preserves_the_entire_envelope() {
        let conn = database();
        let original = json!({"publicBaseUrl":"https://panel.test","google":{"enabled":true,"clientSecretEnc":"enc1:fixture","boundAccounts":[{"id":"original"}]}}).to_string();
        conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&original]).unwrap();
        migrate_legacy_storage(&conn).unwrap();
        assert_eq!(read(&conn, KEY_PANEL_OAUTH), Some(original));
        assert_eq!(read(&conn, "panelOauth"), None);
        migrate_legacy_storage(&conn).unwrap();
    }

    #[test]
    fn preserves_legacy_settings_and_allows_both_configurations() {
        let conn = database();
        let original = json!({"version":1,"settingsEnc":"enc1:legacy"}).to_string();
        conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&original]).unwrap();
        migrate_legacy_storage(&conn).unwrap();
        assert_eq!(read(&conn, "panelOauth"), Some(original.clone()));
        assert_eq!(read(&conn, KEY_PANEL_OAUTH), None);
        conn.execute("INSERT INTO kv VALUES (?1,'{}')", [KEY_PANEL_OAUTH]).unwrap();
        migrate_legacy_storage(&conn).unwrap();
        assert_eq!(read(&conn, "panelOauth"), Some(original));
        assert_eq!(read(&conn, KEY_PANEL_OAUTH), Some("{}".into()));
    }

    #[test]
    fn an_existing_destination_never_uses_or_overwrites_the_previous_slot() {
        let conn = database();
        let previous = json!({"publicBaseUrl":"https://stale.test","google":{}}).to_string();
        conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&previous]).unwrap();
        conn.execute("INSERT INTO kv VALUES (?1,'{\"publicBaseUrl\":\"https://current.test\",\"google\":{}}')", [KEY_PANEL_OAUTH]).unwrap();
        migrate_legacy_storage(&conn).unwrap();
        assert_eq!(read(&conn, "panelOauth"), Some(previous));
        assert!(read(&conn, KEY_PANEL_OAUTH).unwrap().contains("current.test"));
    }

    #[test]
    fn malformed_and_ambiguous_settings_are_never_moved() {
        for value in ["invalid".to_owned(), "{}".to_owned(), json!({"publicBaseUrl":"https://panel.test","google":{},"settingsEnc":"enc1:legacy"}).to_string()] {
            let conn = database();
            conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&value]).unwrap();
            migrate_legacy_storage(&conn).unwrap();
            assert_eq!(read(&conn, "panelOauth"), Some(value));
            assert_eq!(read(&conn, KEY_PANEL_OAUTH), None);
        }
    }

    #[test]
    fn migration_failure_rolls_back_and_returns_the_sql_error() {
        let conn = database();
        let previous = json!({"publicBaseUrl":"https://panel.test","github":{}}).to_string();
        conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&previous]).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_oauth_delete BEFORE DELETE ON kv BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
        assert!(migrate_legacy_storage(&conn).is_err());
        assert_eq!(read(&conn, "panelOauth"), Some(previous));
        assert_eq!(read(&conn, KEY_PANEL_OAUTH), None);
    }

    #[test]
    fn migration_inside_an_existing_transaction_preserves_outer_rollback() {
        let conn = database();
        let previous = json!({"publicBaseUrl":"https://panel.test","google":{}}).to_string();
        conn.execute("INSERT INTO kv VALUES ('panelOauth',?1)", [&previous]).unwrap();
        conn.execute_batch("BEGIN").unwrap();
        migrate_legacy_storage(&conn).unwrap();
        assert!(!conn.is_autocommit());
        assert_eq!(read(&conn, "panelOauth"), None);
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(read(&conn, "panelOauth"), Some(previous));
        assert_eq!(read(&conn, KEY_PANEL_OAUTH), None);
    }
}
