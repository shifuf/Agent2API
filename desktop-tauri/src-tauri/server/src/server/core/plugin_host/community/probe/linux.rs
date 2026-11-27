use super::super::{archives, inspect_archive, EXPANDED_LIMIT};
use super::{Error, Request, UNAVAILABLE};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tempfile::NamedTempFile;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{oneshot, Semaphore},
};

const FAILED: Error = (422, "隔离客体未确认 server hook 完成，不会启用插件");
const ENTRY_LIMIT: u64 = 256 * 1024;
const IMAGE_LIMIT: u64 = 128 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn only_operator_decimal_budgets_within_bounds_are_valid() {
        assert_eq!(budget(None), Ok(80));
        for (input, expected) in [("30", 30), ("80", 80), ("300", 300)] {
            assert_eq!(budget(Some(OsStr::new(input))), Ok(expected));
        }
        for input in ["", "29", "301", "unlimited", "+100", " 30", "1.5"] {
            assert_eq!(budget(Some(OsStr::new(input))), Err(UNAVAILABLE));
        }
        assert_eq!(budget(Some(OsStr::from_bytes(&[0xff]))), Err(UNAVAILABLE));
    }
}

fn budget(value: Option<&std::ffi::OsStr>) -> Result<u64, Error> {
    let Some(value) = value else { return Ok(80) };
    value.to_str()
        .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (30..=300).contains(seconds))
        .ok_or(UNAVAILABLE)
}

pub(super) fn kit() -> Result<(PathBuf, u64), Error> {
    let wall = budget(std::env::var_os("AGENT2API_COMMUNITY_GUEST_TIMEOUT_SECS").as_deref())?;
    if unsafe {
        libc::getuid() == 0 || libc::geteuid() == 0 || libc::getgid() == 0 || libc::getegid() == 0
    } {
        return Err(UNAVAILABLE);
    }
    let status = fs::read_to_string("/proc/self/status").map_err(|_| UNAVAILABLE)?;
    for name in ["CapPrm:", "CapEff:", "CapAmb:"] {
        if !status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .is_some_and(|mask| u64::from_str_radix(mask.trim(), 16) == Ok(0))
        {
            return Err(UNAVAILABLE);
        }
    }
    let path = PathBuf::from(std::env::var_os("AGENT2API_COMMUNITY_GUEST_DIR").ok_or(UNAVAILABLE)?);
    if !path.is_absolute() || path.canonicalize().ok().as_ref() != Some(&path) {
        return Err(UNAVAILABLE);
    }
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| UNAVAILABLE)?;
        if !meta.is_dir()
            || meta.uid() != 0
            || (meta.mode() & 0o022 != 0 && (ancestor == path || meta.mode() & 0o1000 == 0))
        {
            return Err(UNAVAILABLE);
        }
    }
    let mut count = 0;
    for item in fs::read_dir(&path).map_err(|_| UNAVAILABLE)? {
        let meta =
            fs::symlink_metadata(item.map_err(|_| UNAVAILABLE)?.path()).map_err(|_| UNAVAILABLE)?;
        count += 1;
        if count > 32 || !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o6022 != 0 {
            return Err(UNAVAILABLE);
        }
    }
    for filename in [
        "qemu-system-x86_64",
        "vmlinuz",
        "bios.bin",
        "runtime.cpio.gz",
        "linuxboot_dma.bin",
    ] {
        let meta = fs::metadata(path.join(filename)).map_err(|_| UNAVAILABLE)?;
        if !meta.is_file()
            || meta.len() == 0
            || meta.len() > IMAGE_LIMIT
            || (filename == "qemu-system-x86_64" && meta.mode() & 0o111 == 0)
        {
            return Err(UNAVAILABLE);
        }
    }
    Ok((path, wall))
}

fn entry(request: &Request) -> Result<Vec<u8>, Error> {
    let invalid = (
        400,
        "探测只支持归档中已验证的独立 JavaScript / ESM 入口（最多 256 KiB）",
    );
    let bytes = archives::read_current(&request.name, &request.sha256)?;
    let metadata = inspect_archive(&bytes, &request.sha256).map_err(|reason| (400, reason))?;
    if metadata["name"].as_str() != Some(&request.name) {
        return Err(invalid);
    }
    let name = metadata["entry"].as_str().ok_or(invalid)?;
    if !name.ends_with(".mjs") && !name.ends_with(".js") {
        return Err(invalid);
    }
    let decoder = flate2::bufread::GzDecoder::new(bytes.as_slice()).take(EXPANDED_LIMIT as u64 + 1);
    for item in tar::Archive::new(decoder).entries().map_err(|_| invalid)? {
        let mut item = item.map_err(|_| invalid)?;
        let path = item.path().map_err(|_| invalid)?;
        if !item.header().entry_type().is_file()
            || path
                .to_str()
                .and_then(|path| path.split_once('/'))
                .map(|(_, suffix)| suffix)
                != Some(name)
        {
            continue;
        }
        if item.size() == 0 || item.size() > ENTRY_LIMIT {
            return Err(invalid);
        }
        let mut data = Vec::new();
        item.read_to_end(&mut data).map_err(|_| invalid)?;
        std::str::from_utf8(&data).map_err(|_| invalid)?;
        return Ok(data);
    }
    Err(invalid)
}

fn record(output: &mut Vec<u8>, name: &str, mode: u32, data: &[u8]) {
    output.extend_from_slice(b"070701");
    for field in [
        1,
        mode,
        0,
        0,
        1,
        0,
        data.len() as u32,
        0,
        0,
        0,
        0,
        name.len() as u32 + 1,
        0,
    ] {
        write!(output, "{field:08x}").unwrap();
    }
    output.extend_from_slice(name.as_bytes());
    output.push(0);
    while output.len() % 4 != 0 {
        output.push(0);
    }
    output.extend_from_slice(data);
    while output.len() % 4 != 0 {
        output.push(0);
    }
}

fn image(kit: &Path, source: Vec<u8>) -> Result<NamedTempFile, Error> {
    let mut output = NamedTempFile::new().map_err(|_| UNAVAILABLE)?;
    let mut base = fs::File::open(kit.join("runtime.cpio.gz"))
        .map_err(|_| UNAVAILABLE)?
        .take(IMAGE_LIMIT + 1);
    let amount = std::io::copy(&mut base, &mut output).map_err(|_| UNAVAILABLE)?;
    if amount == 0 || amount > IMAGE_LIMIT {
        return Err(UNAVAILABLE);
    }
    let mut overlay = Vec::new();
    record(&mut overlay, "plugin/index.mjs", 0o100444, &source);
    record(&mut overlay, "TRAILER!!!", 0, &[]);
    let pad = (4 - amount % 4) % 4;
    output
        .write_all(&[0; 3][..pad as usize])
        .and_then(|()| output.write_all(&overlay))
        .map_err(|_| UNAVAILABLE)?;
    Ok(output)
}

pub(super) async fn run(request: Request) -> Result<serde_json::Value, Error> {
    let (kit, wall) = kit()?;
    static SLOT: Semaphore = Semaphore::const_new(1);
    let permit = SLOT
        .try_acquire()
        .map_err(|_| (429, "已有隔离探测正在运行"))?;
    let hash = request.sha256.clone();
    let (client, mut canceled) = oneshot::channel::<()>();
    let worker = tokio::spawn(async move {
        let _permit = permit;
        let path = kit.clone();
        let image = tokio::task::spawn_blocking(move || image(&path, entry(&request)?))
            .await
            .map_err(|_| UNAVAILABLE)??;
        if canceled.try_recv() != Err(oneshot::error::TryRecvError::Empty) {
            return Err(FAILED);
        }
        let mut command = Command::new(kit.join("qemu-system-x86_64"));
        command
            .env_clear()
            .env("LD_LIBRARY_PATH", &kit)
            .env("QEMU_MODULE_DIR", &kit)
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .args([
                "-no-user-config",
                "-machine",
                "pc,accel=tcg",
                "-cpu",
                "max",
                "-m",
                "768",
                "-smp",
                "1",
                "-nodefaults",
                "-no-reboot",
                "-display",
                "none",
                "-monitor",
                "none",
                "-serial",
                "stdio",
                "-nic",
                "none",
                "-sandbox",
                "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
                "-L",
            ])
            .arg(&kit)
            .arg("-bios")
            .arg(kit.join("bios.bin"))
            .arg("-kernel")
            .arg(kit.join("vmlinuz"))
            .arg("-initrd")
            .arg(image.path())
            .args([
                "-append",
                "console=ttyS0 quiet loglevel=0 panic=1 rdinit=/init",
            ]);
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                for (resource, limit) in [
                    (libc::RLIMIT_CPU, wall - 15),
                    (libc::RLIMIT_AS, 4 * 1024 * 1024 * 1024u64),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let value = libc::rlimit {
                        rlim_cur: limit as libc::rlim_t,
                        rlim_max: limit as libc::rlim_t,
                    };
                    if libc::setrlimit(resource, &value) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|_| UNAVAILABLE)?;
        let mut stream = child.stdout.take().ok_or(UNAVAILABLE)?.take(8193);
        let result = tokio::select! {
            _=&mut canceled=>Err(FAILED),
            _=tokio::time::sleep(Duration::from_secs(wall))=>Err((504,"隔离探测超时，客体已终止")),
            result=async {
                let mut bytes=Vec::new();stream.read_to_end(&mut bytes).await.map_err(|_|FAILED)?;
                if bytes.len()>8192{return Err(FAILED);}
                let status=child.wait().await.map_err(|_|FAILED)?;
                if !status.success() || !bytes.split(|byte|*byte==b'\n').any(|line|line.strip_suffix(b"\r").unwrap_or(line)==b"A2API_DIAGNOSTIC_HOOK_COMPLETED") {return Err(FAILED);}
                Ok(())
            }=>result,
        };
        if result.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        result
    });
    let result = worker.await.map_err(|_| UNAVAILABLE)?;
    drop(client);
    result?;
    Ok(
        serde_json::json!({"status":"completed","hook":"server","sha256":hash,"metadataOnly":true,"installed":false}),
    )
}
