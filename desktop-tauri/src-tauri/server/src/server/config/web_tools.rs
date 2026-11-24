use serde_json::Value;

use crate::server::errors::GatewayError;

pub const KEY: &str = "webToolEmulation";

pub fn enabled() -> bool {
    super::with_raw(|raw| enabled_in(raw.get(KEY))).unwrap_or(true)
}

pub fn enabled_in(value: Option<&Value>) -> bool {
    // 缺省只启用插件明确声明的模拟契约，不扩大旧插件或原生通道的能力。
    value.is_none_or(|value| value == &Value::Bool(true))
}

pub fn save(enabled: bool) -> Result<(), GatewayError> {
    super::try_update_raw_field(
        KEY,
        |value| {
            *value = Value::Bool(enabled);
            Ok(())
        },
        || GatewayError::new("保存网页工具调用设置失败"),
    )
}
