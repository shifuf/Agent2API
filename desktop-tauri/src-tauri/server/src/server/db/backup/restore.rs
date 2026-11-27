use std::path::Path;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::server::core::{cloud_sync, limiter, usage_records};
use crate::server::db::schema;
use crate::server::{access, config, logging};

use super::{
    account_key_warning, archive, complete_backup, keys, parse_account_key_fingerprint, safety,
    set_phase, sql_import, table_row_counts, validate_required_tables, Db, RestorePhase,
    TempRestoreDb, BACKUP_SQL_HEADER,
};

pub(super) fn import(
    db: &Db,
    source: &Path,
    config_dir: &Path,
    password: &str,
) -> Result<Value, String> {
    #[cfg(feature = "task-plugins")]
    let _task_restore = crate::server::core::task_plugins::restore_guard()?;
    set_phase(RestorePhase::Decrypting);
    let mut backup = archive::read(source, password, config_dir)?;
    let header = sql_import::header(&mut backup.sql)?;
    let header = header.trim_start_matches('\u{feff}');
    if !header.trim_start().starts_with(BACKUP_SQL_HEADER) {
        return Err("仅支持由 Agent2API 导出的整库备份（缺少文件头标记）".into());
    }
    let warning = if backup.keys.is_none() {
        account_key_warning(parse_account_key_fingerprint(header))
    } else {
        None
    };
    let mut temp = TempRestoreDb::new(config_dir)?;
    set_phase(RestorePhase::Applying);
    sql_import::apply(&temp.conn, &mut backup.sql)?;
    if !temp.conn.is_autocommit() {
        let _ = temp.conn.execute_batch("ROLLBACK;");
        return Err("备份文件的事务未完成，文件可能被截断".into());
    }
    set_phase(RestorePhase::Validating);
    let version: i64 = temp
        .conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取备份库版本失败: {error}"))?;
    if backup
        .schema_version
        .is_some_and(|expected| expected != version)
    {
        return Err("备份清单与数据库版本不一致".into());
    }
    if version > schema::SCHEMA_VERSION {
        return Err(format!(
            "备份来自更新版本的应用（库版本 {version} > 当前 {}），请先升级本应用",
            schema::SCHEMA_VERSION
        ));
    }
    validate_required_tables(&temp.conn)?;
    schema::migrate(&temp.conn).map_err(|error| format!("对齐备份库 schema 失败: {error}"))?;
    let integrity: String = temp
        .conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("检查备份完整性失败: {error}"))?;
    if integrity != "ok" {
        return Err("备份数据库完整性检查未通过".into());
    }
    let restored_keys = backup
        .keys
        .as_ref()
        .map(|keys| keys.names())
        .unwrap_or_default();
    let reencrypted_secrets = if let Some(keys) = backup.keys.as_ref() {
        keys::validate(&temp.conn, keys)?;
        set_phase(RestorePhase::Reencrypting);
        keys::reencrypt(&mut temp.conn, keys)?
    } else {
        0
    };
    temp.conn.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false).map_err(|_| "无法隔离恢复中的任务")?;
    for table in super::TRANSIENT_TABLES {
        let exists: bool = temp.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)", [table], |row| row.get(0)).map_err(|_| "无法检查临时图像数据")?;
        if exists { temp.conn.execute(&format!("DELETE FROM {table}"), []).map_err(|_| "无法清除临时图像数据")?; }
    }
    temp.conn.execute_batch("UPDATE task_plugins SET enabled=0, notify_allowed=0; UPDATE task_jobs SET enabled=0, next_run_at=NULL;").map_err(|_| "无法清除备份中的任务授权")?;
    let interrupted = "从备份恢复，原执行已中断";
    temp.conn.execute(
        "UPDATE task_job_runs SET status='failed', finished_at=MAX(started_at, ?1), error=?2 WHERE status='running'",
        rusqlite::params![logging::now_ms(), interrupted],
    ).map_err(|_| "无法终结备份中未完成的执行记录")?;
    temp.conn.execute(
        "UPDATE task_jobs SET last_status='failed', last_error=?1 WHERE last_status='running'",
        [interrupted],
    ).map_err(|_| "无法终结备份中未完成的实例状态")?;
    let tables = table_row_counts(&temp.conn, &[]);
    set_phase(RestorePhase::SafetyBackup);
    enum RestoreOutcome {
        Ready(std::path::PathBuf),
        RolledBack(String),
        Corrupted(String),
    }

    let suppression = cloud_sync::auto_sync::SuppressionGuard::new();
    if !config::model_key_source::pre_replace() {
        return Err("模型Key原授权无法安全撤销，未替换主数据库".into());
    }
    // 原epoch先真实耐久轮换，随后暂存库另写新隔离epoch，最后才创建安全备份和覆盖。
    // 因而安全备份本身已隔离；覆盖失败回滚、应用重启均不能恢复本次之前的旧发送资格。
    // 槽payload不参与密钥重加密：原样保留但永远属于旧epoch，不按ID解密或建立Ready。
    let attempt = db.with_account_change(|change| change.restore(&temp.conn, |main| {
        db.invalidate_accounts();
        db.invalidate_requests();
        let safety = safety::create(main, config_dir)?;
        set_phase(RestorePhase::Replacing);
        if let Err(error) = replace(&temp.conn, main) {
            set_phase(RestorePhase::RollingBack);
            let rollback = Connection::open_with_flags(&safety, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| format!("打开安全备份失败: {error}"))
                .and_then(|old| replace(&old, main));
            db.invalidate_accounts();
            return Ok(match rollback {
                Ok(()) => RestoreOutcome::RolledBack(format!("{error}；已自动还原替换前的业务数据，本机密钥未更换；旧换证资格仍保持隔离")),
                Err(rollback_error) => RestoreOutcome::Corrupted(format!("{error}；自动还原失败: {rollback_error}。安全备份保存在 {}，本机密钥未更换", safety.display())),
            });
        }
        crate::server::core::model_pricing::fx::database_replaced(main);
        db.invalidate_accounts();
        Ok(RestoreOutcome::Ready(safety))
    }));
    let safety = match attempt {
        Some(Ok(RestoreOutcome::Ready(safety))) => safety,
        Some(Ok(RestoreOutcome::RolledBack(error))) | Some(Err(error)) => {
            db.invalidate_accounts();
            config::try_reload_from_db();
            return Err(error);
        }
        Some(Ok(RestoreOutcome::Corrupted(error))) => {
            db.invalidate_accounts();
            return Err(error);
        }
        None => {
            config::try_reload_from_db();
            return Err("数据库连接不可用，恢复未执行".into());
        }
    };
    db.invalidate_accounts();
    set_phase(RestorePhase::Reloading);
    // 内核进程仍使用恢复前的订阅与目录；先停旧进程，再用恢复后的配置重建。
    let kernel_halted = crate::server::core::sub_kernel::is_manually_halted();
    crate::server::core::sub_kernel::shutdown();
    config::reload();
    let providers = crate::server::core::subscriptions::enabled_provider_inputs();
    if providers.is_empty() {
        crate::server::core::sub_kernel::request_stop();
    } else if !kernel_halted && crate::server::core::sub_kernel::installed() {
        crate::server::core::sub_kernel::request_restart(providers);
    }
    usage_records::reload_facts();
    limiter::sources::reload();
    limiter::counter::invalidate();
    access::load_refresh_tokens();
    access::clear_access_tokens();
    drop(suppression);
    let safety_name = safety
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    logging::log(
        "[Storage]",
        &format!(
            "📥 整库恢复完成: {} 张表，已迁移 {reencrypted_secrets} 项加密凭证；安全备份: {}",
            tables.len(),
            safety.display()
        ),
    );
    let mut result = json!({
        "tables": tables,
        "safetyBackup": safety_name,
        "restoredKeys": restored_keys,
        "reencryptedSecrets": reencrypted_secrets,
        "localKeysPreserved": true,
        "encrypted": backup.keys.is_some(),
    });
    if let Some(warning) = warning {
        logging::log("[Storage]", &format!("⚠️ 整库恢复密钥警告: {warning}"));
        result["warning"] = json!(warning);
    }
    Ok(result)
}

#[cfg(test)]
thread_local! {
    static FAIL_REPLACE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) fn fail_next_replace() {
    FAIL_REPLACE.with(|flag| flag.set(true));
}

fn replace(source: &Connection, target: &mut Connection) -> Result<(), String> {
    super::super::invalidate_query_caches();
    let backup =
        Backup::new(source, target).map_err(|error| format!("初始化数据库替换失败: {error}"))?;
    complete_backup(&backup, "恢复主数据库")?;
    #[cfg(test)]
    if FAIL_REPLACE.with(|flag| flag.replace(false)) {
        return Err("测试注入：数据库替换后中断".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::request_stats::{ApiKeyIdentity, NewRequestEntry, RequestStats, Retention};

    #[test]
    fn review_restore_refreshes_warm_request_filter_dimensions_without_new_traffic() {
        let _ = logging::process_started_at();
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("target.db")).unwrap();
        let stats = RequestStats::with_db(Some(db.clone()), Retention::default);
        stats.record(NewRequestEntry::new("before-restore", 200));
        assert_eq!(stats.filter_options()["models"], json!(["before-restore"]));

        let source = Db::open(&directory.path().join("source.db")).unwrap();
        let source_stats = RequestStats::with_db(Some(source.clone()), Retention::default);
        let mut entry = NewRequestEntry::new("restored-model", 200);
        entry.provider = Some("restored-provider".into());
        entry.source.client = "restored-client".into();
        entry.source.api_key = ApiKeyIdentity {
            source: "key".into(), id: "restored-key".into(), name: "Restored key".into(),
        };
        source_stats.record(entry);
        let backup_file = directory.path().join("restore.sql");
        let mut writer = std::fs::File::create(&backup_file).unwrap();
        source.with(|conn| super::super::dump_sql_into(conn, &[], &mut writer)).unwrap().unwrap();
        drop(writer);

        super::super::import_from_file(&db, &backup_file, directory.path(), "").unwrap();
        let options = stats.filter_options();
        assert_eq!(options["models"], json!(["restored-model"]));
        assert_eq!(options["providers"][0]["id"], "restored-provider");
        assert!(options["clients"].as_array().unwrap().iter().any(|item| item["value"] == "restored-client"));
        assert!(options["apiKeys"].as_array().unwrap().iter().any(|item| item["value"] == "key:restored-key"));
    }
}
