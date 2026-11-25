//! 传输抽象：把「读一个文件 / 写一个文件」从「WebDAV 还是 S3」里解耦。
//!
//! 协议层（`super::mod` 的上传 / 下载 / 远端信息）只认识 [`Transport`] 的三个方法，
//! 因此加第三种存储（比如 SMB / FTP）只需再实现一个 trait，不必改动协议逻辑。
//! 与 cc-switch 把 `sync_protocol` 与 `webdav` / `s3` 分层的理由一致。

use super::manifest::{self, ArtifactMeta, MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES};
use super::{s3, settings, webdav};

/// 一次同步要用到的传输实现
pub(crate) enum Transport {
    WebDav {
        base_url: String,
        auth: webdav::WebDavAuth,
        /// 远端目录段（`remoteRoot/v1/profile`），每次读写都要拼
        segments: Vec<String>,
        /// 自定义 User-Agent；空 = 默认。部分服务按它校验客户端类型
        user_agent: String,
    },
    S3 {
        credentials: s3::S3Credentials,
        /// 远端目录（对象键前缀）：`remoteRoot/v1/profile`
        prefix: String,
    },
}

impl Transport {
    /// 从设置构造（密码在这里解出明文，只在本次操作的内存里存活）
    pub(crate) fn from_settings(settings: &settings::CloudSyncSettings) -> Result<Self, String> {
        let segments = manifest::remote_dir_segments(&settings.remote_root, &settings.profile)?;
        match settings.provider.as_str() {
            settings::PROVIDER_S3 => Ok(Transport::S3 {
                credentials: s3::S3Credentials {
                    access_key_id: settings.s3.access_key_id.clone(),
                    secret_access_key: settings.s3_secret_plain()?,
                    region: settings.s3.region.clone(),
                    bucket: settings.s3.bucket.clone(),
                    endpoint: settings.s3.endpoint.clone(),
                    user_agent: settings.s3.user_agent.clone(),
                },
                prefix: segments.join("/"),
            }),
            _ => Ok(Transport::WebDav {
                base_url: settings.webdav.base_url.clone(),
                auth: webdav::auth_from_credentials(
                    &settings.webdav.username,
                    &settings.webdav_password_plain()?,
                ),
                segments,
                user_agent: settings.webdav.user_agent.clone(),
            }),
        }
    }

    /// 远端目录的展示路径
    pub(crate) fn display_path(&self) -> String {
        match self {
            Transport::WebDav { segments, .. } => format!("/{}", segments.join("/")),
            Transport::S3 { credentials, prefix } => {
                format!("{}/{prefix}", credentials.bucket)
            }
        }
    }

    /// 测试连接（顺带把目录建好，避免第一次上传才发现没权限）
    pub(crate) async fn test_connection(&self) -> Result<(), String> {
        match self {
            Transport::WebDav {
                base_url,
                auth,
                segments,
                user_agent,
            } => {
                webdav::test_connection(base_url, auth, user_agent).await?;
                webdav::ensure_remote_directories(base_url, segments, auth, user_agent).await
            }
            Transport::S3 { credentials, .. } => s3::test_connection(credentials).await,
        }
    }

    /// 写一个文件（协议层保证 manifest 最后写，见 `manifest` 模块头）
    pub(crate) async fn put(
        &self,
        name: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), String> {
        match self {
            Transport::WebDav {
                base_url,
                auth,
                segments,
                user_agent,
            } => {
                let mut file_segments = segments.clone();
                file_segments.extend(manifest::sanitize_segments(name)?);
                let url = webdav::build_remote_url(base_url, &file_segments)?;
                webdav::put_bytes(&url, auth, bytes, content_type, user_agent).await
            }
            Transport::S3 { credentials, prefix } => {
                let key = format!("{prefix}/{}", name.trim_start_matches('/'));
                s3::put_object(credentials, &key, bytes, content_type).await
            }
        }
    }

    pub(crate) async fn ensure_directory(&self, name: &str) -> Result<(), String> {
        if let Self::WebDav { base_url, auth, segments, user_agent } = self {
            let mut directory = segments.clone(); directory.extend(manifest::sanitize_segments(name)?);
            webdav::ensure_remote_directories(base_url, &directory, auth, user_agent).await?;
        }
        Ok(())
    }
    pub(crate) async fn delete(&self, name: &str) -> Result<(), String> {
        let pieces = manifest::sanitize_segments(name)?;
        match self {
            Self::WebDav { base_url, auth, segments, user_agent } => {
                let mut file = segments.clone(); file.extend(pieces);
                webdav::delete(&webdav::build_remote_url(base_url, &file)?, auth, user_agent).await
            }
            Self::S3 { credentials, prefix } => s3::delete_object(credentials, &format!("{prefix}/{}",pieces.join("/"))).await,
        }
    }
    async fn is_regular_file(&self, name: &str) -> Result<bool, String> {
        if let Self::WebDav { base_url, auth, segments, user_agent } = self {
            let mut parts = manifest::sanitize_segments(name)?;
            let Some(filename) = parts.pop() else { return Ok(false) };
            let mut parent = segments.clone(); parent.extend(parts);
            let entries = webdav::children(&webdav::build_remote_url(base_url,&parent)?,auth,user_agent).await?;
            return Ok(entries.iter().any(|(name,is_directory)|name==&filename && !is_directory));
        }
        Ok(true)
    }
    pub(crate) async fn delete_regular(&self,name: &str) -> Result<(),String> {
        if self.is_regular_file(name).await? { self.delete(name).await?; }
        Ok(())
    }
    async fn directory_names(&self,name: &str) -> Result<std::collections::BTreeSet<String>,String> {
        match self {
            Self::WebDav { base_url,auth,segments,user_agent } => {
                let mut parts=segments.clone();parts.extend(manifest::sanitize_segments(name)?);
                Ok(webdav::child_names(&webdav::build_remote_url(base_url,&parts)?,auth,user_agent).await?.into_iter().collect())
            }
            Self::S3 { credentials,prefix } => {
                let root=format!("{prefix}/{name}/");
                Ok(s3::list_keys(credentials,&root).await?.iter().filter_map(|key|
                    key.strip_prefix(&root).and_then(|rest|rest.split_once('/')).map(|(child,_)|child.to_string())).collect())
            }
        }
    }
    pub(crate) async fn remove_history_artifacts(&self, directory: &str, stored: &manifest::SyncManifest,
        keep: Option<&std::collections::BTreeMap<String,ArtifactMeta>>) -> Result<(),String> {
        if stored.format != manifest::PROTOCOL_FORMAT || stored.version != manifest::PROTOCOL_VERSION { return Ok(()) }
        for name in stored.artifacts.keys() {
            if keep.is_some_and(|artifacts|artifacts.contains_key(name)) { continue }
            if !owned_history_artifact(name) { continue }
            let object = format!("{directory}/{name}");
            if self.is_regular_file(&object).await? { self.delete(&object).await?; }
        }
        Ok(())
    }
    pub(crate) async fn prune_history(&self, now: i64) -> Result<(), String> {
        let dates=self.directory_names("history").await?;
        for date in dates {
            let Ok(parsed)=chrono::NaiveDate::parse_from_str(&date,"%Y-%m-%d") else { continue };
            if parsed.format("%Y-%m-%d").to_string()!=date { continue }
            let directory=format!("history/{date}");
            let manifest_name=format!("{directory}/{}",manifest::REMOTE_MANIFEST);
            let stored=if self.is_regular_file(&manifest_name).await? {
                self.get(&manifest_name,MAX_MANIFEST_BYTES).await?.and_then(|bytes|serde_json::from_slice::<manifest::SyncManifest>(&bytes).ok())
            } else { None };
            let stored=stored.filter(|value|value.format==manifest::PROTOCOL_FORMAT&&value.version==manifest::PROTOCOL_VERSION);
            let expired=super::policy::expired_day(&date,now);
            for generation in self.directory_names(&directory).await? {
                if generation.len()!=64 || !generation.bytes().all(|b|b.is_ascii_hexdigit()) { continue }
                if !expired && stored.as_ref().is_some_and(|value|value.artifacts.keys().any(|name|name.starts_with(&format!("{generation}/")))) { continue }
                let staged=format!("{directory}/{generation}");
                let marker=format!("{staged}/{}",manifest::REMOTE_MANIFEST);
                if !self.is_regular_file(&marker).await? { continue }
                let Some(bytes)=self.get(&marker,MAX_MANIFEST_BYTES).await? else { continue };
                let Ok(owned)=serde_json::from_slice::<manifest::SyncManifest>(&bytes) else { continue };
                if owned.format!=manifest::PROTOCOL_FORMAT||owned.version!=manifest::PROTOCOL_VERSION { continue }
                self.remove_history_artifacts(&staged,&owned,None).await?;
                self.delete_regular(&marker).await?;
            }
            if expired {
                if let Some(stored)=stored {
                    self.remove_history_artifacts(&directory,&stored,None).await?;
                    self.delete_regular(&manifest_name).await?;
                }
            }
        }
        Ok(())
    }

    /// 读一个文件；不存在返回 `None`（「远端还没有」是正常状态）
    pub(crate) async fn get(
        &self,
        name: &str,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        match self {
            Transport::WebDav {
                base_url,
                auth,
                segments,
                user_agent,
            } => {
                let mut file_segments = segments.clone();
                file_segments.extend(manifest::sanitize_segments(name)?);
                let url = webdav::build_remote_url(base_url, &file_segments)?;
                webdav::get_bytes(&url, auth, max_bytes, user_agent).await
            }
            Transport::S3 { credentials, prefix } => {
                let key = format!("{prefix}/{}", name.trim_start_matches('/'));
                s3::get_object(credentials, &key, max_bytes).await
            }
        }
    }

    /// 读 manifest（带体积上限）
    pub(crate) async fn get_manifest(
        &self,
    ) -> Result<Option<(Vec<u8>, manifest::SyncManifest)>, String> {
        let Some(bytes) = self.get(manifest::REMOTE_MANIFEST, MAX_MANIFEST_BYTES).await? else {
            return Ok(None);
        };
        let parsed: manifest::SyncManifest = serde_json::from_slice(&bytes).map_err(|error| {
            format!("远端 manifest.json 不是合法 JSON（可能不是本功能生成的文件）: {error}")
        })?;
        Ok(Some((bytes, parsed)))
    }

    /// 读一个 artifact 并按 manifest 校验（size + sha256）
    pub(crate) async fn get_artifact(
        &self,
        name: &str,
        artifacts: &std::collections::BTreeMap<String, ArtifactMeta>,
    ) -> Result<Vec<u8>, String> {
        let meta = artifacts.get(name).ok_or_else(|| {
            format!("远端 manifest 里没有 {name}（这份快照不完整，请重新上传）")
        })?;
        if meta.size > MAX_ARTIFACT_BYTES {
            return Err(format!(
                "远端 {name} 超过上限（{} 字节 > {MAX_ARTIFACT_BYTES} 字节）",
                meta.size
            ));
        }
        let bytes = self
            .get(name, MAX_ARTIFACT_BYTES as usize)
            .await?
            .ok_or_else(|| format!("远端缺少 {name}（manifest 说有、实际读不到）"))?;
        manifest::verify_artifact(&bytes, name, meta)?;
        Ok(bytes)
    }
}

fn owned_history_artifact(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    let file = match parts.as_slice() {
        [file] => *file,
        [generation,file] if generation.len()==64 && generation.bytes().all(|b|b.is_ascii_hexdigit()) => *file,
        _ => return false,
    };
    [manifest::REMOTE_SNAPSHOT,manifest::REMOTE_KEY_FILE].contains(&file)
}
#[cfg(test)]
mod history_tests {
    use super::*;
    #[test] fn only_protocol_files_and_immutable_generation_paths_can_be_deleted() {
        assert!(owned_history_artifact("snapshot.json"));
        assert!(owned_history_artifact(&format!("{}/snapshot.json","a".repeat(64))));
        for name in ["../snapshot.json","snapshot.json/data.txt","notes","manifest.json","day/snapshot.json","a/account.key.enc/extra"] {
            assert!(!owned_history_artifact(name));
        }
    }
}
