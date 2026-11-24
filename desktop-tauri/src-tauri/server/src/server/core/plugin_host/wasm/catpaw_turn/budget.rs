//! CatPaw 保留材料的真实进程预算；原所有者持有配额，未知清理不得通过删记录回收。
use std::sync::atomic::{AtomicUsize, Ordering};
use agent2api_provider_protocol as proto;
use serde_json::Value;

const MAX_BYTES: usize = 256 * 1024 * 1024;
static RETAINED: AtomicUsize = AtomicUsize::new(0);

pub(in crate::server::core::plugin_host::wasm) struct Allocation { bytes: usize }
impl Allocation {
    pub(in crate::server::core::plugin_host::wasm) fn new(bytes: usize) -> Result<Self, proto::WireError> {
        RETAINED.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(bytes).filter(|total| *total <= MAX_BYTES)
        }).map_err(|_| super::error::budget())?;
        Ok(Self { bytes })
    }
}
impl Drop for Allocation {
    fn drop(&mut self) { RETAINED.fetch_sub(self.bytes, Ordering::AcqRel); }
}

/// 包含 Value、数组容量和字符串/BTree 节点的保守实际分配估算，溢出即拒绝。
pub(in crate::server::core::plugin_host::wasm) fn value_bytes(value: &Value) -> Result<usize, proto::WireError> {
    fn size(value: &Value, depth: usize, nodes: &mut usize) -> Option<usize> {
        *nodes = nodes.checked_add(1)?;
        if depth > 64 || *nodes > 65_536 { return None; }
        let base = std::mem::size_of::<Value>();
        match value {
            Value::String(text) => base.checked_add(text.capacity()),
            Value::Array(items) => items.iter().try_fold(base.checked_add(items.capacity().checked_mul(base)?)?,
                |total, item| total.checked_add(size(item, depth + 1, nodes)?)),
            Value::Object(fields) => fields.iter().try_fold(base, |total, (key, item)| {
                total.checked_add(128)?.checked_add(key.capacity())?.checked_add(size(item, depth + 1, nodes)?)
            }),
            _ => Some(base),
        }
    }
    size(value, 0, &mut 0).ok_or_else(super::error::budget)
}
