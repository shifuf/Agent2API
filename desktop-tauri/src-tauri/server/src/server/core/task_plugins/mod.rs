pub mod cron_schedule;
pub(crate) mod probe;
pub mod sandbox;
pub mod scheduler;
pub mod store;
pub mod store_remote;
pub mod types;

use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

static RESTORE_BARRIER: RwLock<()> = RwLock::const_new(());

pub fn running_guard() -> Result<RwLockReadGuard<'static, ()>, String> {
    RESTORE_BARRIER.try_read().map_err(|_| "整库恢复期间不能运行任务".into())
}

pub fn restore_guard() -> Result<RwLockWriteGuard<'static, ()>, String> {
    RESTORE_BARRIER.try_write().map_err(|_| "请先停止任务并等候通知投递结束，再恢复整库".into())
}
