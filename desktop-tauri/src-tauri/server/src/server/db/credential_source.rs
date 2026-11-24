//! 原Db单连接的私有进程来源，只撤销旧读取，不授予账号或发送权限。
//! 适配固定上游33f5e797的credential_epoch；本仓库恢复已在原conn锁内调用invalidate_accounts。
use std::sync::{atomic::Ordering, Arc, Weak};

use rusqlite::Connection;

use super::{DatabaseEntry, Db, DbInner};

pub(super) struct Epoch;

#[must_use]
pub(crate) struct CredentialSource {
    owner: Weak<DbInner>,
    epoch: Arc<Epoch>,
}

impl CredentialSource {
    pub(super) fn matches(&self, db: &Db, epoch: &Arc<Epoch>) -> bool {
        Weak::ptr_eq(&self.owner, &Arc::downgrade(&db.inner))
            && Arc::ptr_eq(&self.epoch, epoch)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum CredentialSourceError { Unavailable, Changed }

impl Db {
    /// 原来源与真实读取同持conn和epoch锁；COMMIT确认后才交付，不能按路径或JSON恢复。
    pub(crate) fn prepare_credential_source<T, E>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, E>,
    ) -> Result<Result<(T, CredentialSource), E>, CredentialSourceError> {
        let _entry = DatabaseEntry::enter(self).ok_or(CredentialSourceError::Unavailable)?;
        let mut conn = self.inner.conn.lock().map_err(|_| CredentialSourceError::Unavailable)?;
        let epoch = self.inner.source_epoch.lock().map_err(|_| CredentialSourceError::Unavailable)?;
        if self.inner.task_guard_unusable.load(Ordering::Acquire) || !conn.is_autocommit() {
            return Err(CredentialSourceError::Unavailable);
        }
        let source = CredentialSource { owner: Arc::downgrade(&self.inner), epoch: epoch.clone() };
        let result = {
            let mut scope = ClosedBorrow { conn: &mut conn, unusable: &self.inner.task_guard_unusable };
            action(scope.connection())
        };
        if self.inner.task_guard_unusable.load(Ordering::Acquire) {
            return Err(CredentialSourceError::Unavailable);
        }
        if !source.matches(self, &epoch) { return Err(CredentialSourceError::Changed); }
        Ok(result.map(|value| (value, source)))
    }

    pub(super) fn revoke_credential_sources(&self) {
        match self.inner.source_epoch.lock() {
            Ok(mut epoch) => *epoch = Arc::new(Epoch),
            Err(_) => self.inner.task_guard_unusable.store(true, Ordering::Release),
        }
    }
}

struct ClosedBorrow<'a> {
    conn: &'a mut Connection,
    unusable: &'a std::sync::atomic::AtomicBool,
}

impl ClosedBorrow<'_> {
    fn connection(&mut self) -> &mut Connection { self.conn }
}

impl Drop for ClosedBorrow<'_> {
    fn drop(&mut self) {
        // 未确认结束的动作不能再签发来源，也不能交给等待中的普通CRUD使用。
        if !self.conn.is_autocommit() {
            self.unusable.store(true, Ordering::Release);
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}
