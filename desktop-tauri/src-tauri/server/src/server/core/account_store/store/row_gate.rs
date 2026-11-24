//! CatPaw原行最后复核：原账号try锁、原Db来源、唯一IMMEDIATE事务。
use std::{any::Any, panic::{catch_unwind, AssertUnwindSafe}, sync::TryLockError};

use super::AccountStore;
use super::super::credential_version::{Error, RowFinalError, RowFinalRead, StorageFailure};
use crate::server::db::TaskTransaction;

impl AccountStore {
    pub(in crate::server::core::account_store) fn try_row_source_final(
        read: &RowFinalRead<'_>, entered: &mut bool, consume: &mut impl FnMut(),
        deferred_unwind: &mut Option<Box<dyn Any + Send>>,
    ) -> Result<TaskTransaction<Result<(), Error>>, RowFinalError> {
        read.with_original_store(|store, source, stamp, key| {
            let _account = match store.inner.lock.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::WouldBlock) => return Err(RowFinalError::AccountBusy),
                Err(TryLockError::Poisoned(_)) => return Err(RowFinalError::AccountPoisoned),
            };
            let db = store.inner.db.as_ref().ok_or(RowFinalError::StoreUnavailable)?;
            Ok(db.try_task_transaction_from(source, |conn| {
                match catch_unwind(AssertUnwindSafe(|| {
                    read.with_key_source(|| {
                        stamp.verify_current(conn, key)?;
                        *entered = true;
                        consume();
                        Ok(())
                    }).ok_or(Error::Conflict(super::super::credential_version::Conflict::HostSourceChanged))?
                })) {
                    Ok(result) => result,
                    Err(payload) => {
                        *deferred_unwind = Some(payload);
                        Err(Error::Storage(StorageFailure::Unavailable))
                    }
                }
            }))
        })
    }
}
