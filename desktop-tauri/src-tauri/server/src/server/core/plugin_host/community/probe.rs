use serde::Deserialize;
use serde_json::Value;

#[cfg(target_os = "linux")]
mod linux;

type Error = (i32, &'static str);
const UNAVAILABLE: Error = (
    503,
    "需要预先安装的非特权 Linux 隔离客体，不能直接运行社区代码",
);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    name: String,
    sha256: String,
}

pub fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::kit().is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub async fn run(request: Request) -> Result<Value, Error> {
    if !super::package_name(&request.name)
        || request.sha256.len() != 64
        || !request
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err((400, "需要已保留的包名和精确 SHA-256"));
    }
    #[cfg(target_os = "linux")]
    {
        linux::run(request).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(UNAVAILABLE)
    }
}
