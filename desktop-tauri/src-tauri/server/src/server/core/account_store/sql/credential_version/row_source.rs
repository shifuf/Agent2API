//! 两家只读行来源只由真实单行IMMEDIATE事务提交后产生；不带账号写入或执行许可。

use rusqlite::{Connection, TransactionBehavior};
use serde_json::Value;

use super::{row_projection::Projection, storage, Conflict, Error, StorageFailure, Version};
use crate::server::core::account_store::{credential_version::RowProvider, state::StoredAccount};

pub(in crate::server::core::account_store) struct RowStamp {
    provider: RowProvider,
    id: String,
    version: Version,
    projection: Projection,
    account_maintenance: bool,
}

impl RowStamp {
    pub(in crate::server::core::account_store) fn provider(&self) -> RowProvider {
        self.provider
    }
    pub(in crate::server::core::account_store) fn account(&self) -> &str {
        &self.id
    }
    pub(in crate::server::core::account_store) fn secret(&self) -> &Value {
        self.projection.secret()
    }
    pub(in crate::server::core::account_store) fn identity(&self) -> &str {
        self.projection.identity()
    }
    pub(in crate::server::core::account_store) fn user_agent(&self) -> Option<&str> {
        self.projection.user_agent()
    }

    /// 仅在原来源已验证的只读事务内重读原行；不接受替代账号、外来记录或新epoch。
    pub(in crate::server::core::account_store) fn verify_current(
        &self,
        conn: &Connection,
        key: &[u8; 32],
    ) -> Result<(), Error> {
        if conn.is_autocommit() {
            return Err(Error::Storage(StorageFailure::Begin));
        }
        let epoch = storage::epoch(conn)?.ok_or(Error::Conflict(Conflict::DatabaseEpochChanged))?;
        if epoch != self.version.epoch {
            return Err(Error::Conflict(Conflict::DatabaseEpochChanged));
        }
        let current = storage::load_for(conn, key, self.provider.id(), &self.id)?;
        self.compare(&current, &epoch)
    }

    /// 纯比较只留在本模块；最终检查不得从调用者提供的JSON或epoch签发来源。
    fn compare(&self, current: &StoredAccount, epoch: &str) -> Result<(), Error> {
        if current.id() != self.id || current.provider() != self.provider.id() {
            return Err(Error::Conflict(Conflict::ProviderChanged));
        }
        if !self.account_maintenance && !current.enabled() {
            return Err(Error::Conflict(Conflict::AuthorizationChanged));
        }
        if epoch != self.version.epoch {
            return Err(Error::Conflict(Conflict::DatabaseEpochChanged));
        }
        let version =
            storage::version(current)?.ok_or(Error::Conflict(Conflict::UnestablishedVersion))?;
        if version != self.version {
            return Err(Error::Conflict(Conflict::VersionChanged));
        }
        if Projection::read(current, self.provider)? != self.projection {
            return Err(Error::Conflict(Conflict::AuthorizationChanged));
        }
        Ok(())
    }
}

pub(in crate::server::core::account_store) fn prepare(
    conn: &mut Connection,
    key: &[u8; 32],
    provider: RowProvider,
    id: &str,
    account_maintenance: bool,
) -> Result<RowStamp, Error> {
    super::check_id(id)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage::sql_error(error, StorageFailure::Begin))?;
    let result = (|| {
        let mut record = storage::load_for(&tx, key, provider.id(), id)?;
        if !account_maintenance && !record.enabled() {
            return Err(Error::Conflict(Conflict::AuthorizationChanged));
        }
        let projection = Projection::read(&record, provider)?;
        let existing = storage::version(&record)?;
        let epoch = storage::epoch(&tx)?;
        let (version, establish) = match (existing, epoch) {
            (Some(version), Some(epoch)) if version.epoch == epoch => (version, false),
            (previous, epoch) => {
                let epoch = match epoch {
                    Some(epoch) => epoch,
                    None => storage::establish_epoch(&tx)?,
                };
                let born = storage::random_id()?;
                if previous
                    .as_ref()
                    .is_some_and(|version| version.born == born)
                {
                    return Err(Error::Storage(StorageFailure::RandomUnavailable));
                }
                (
                    Version {
                        epoch,
                        born,
                        revision: 1,
                    },
                    true,
                )
            }
        };
        if establish {
            storage::set_version(&mut record, &version);
            storage::update_existing_for(&tx, key, provider.id(), &record)?;
            let written = storage::load_for(&tx, key, provider.id(), id)?;
            if written.fields() != record.fields() {
                return Err(Error::Storage(StorageFailure::Write));
            }
        }
        let stamp = RowStamp {
            provider,
            id: id.to_string(),
            version,
            projection,
            account_maintenance,
        };
        stamp.compare(&record, &stamp.version.epoch)?;
        Ok(stamp)
    })();
    super::finish(tx, result)
}
