use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[test]
fn public_answers_and_canonical_targets_only() {
    let first: SocketAddr="9.9.9.9:443".parse().unwrap();
    assert!(permitted_addresses(&[first]));
    for ip in ["127.0.0.1", "10.0.0.1", "169.254.1.2", "192.0.0.8", "100.64.0.1", "198.19.1.1", "::1", "fc00::2", "::ffff:127.0.0.1", "2002::9", "2001:db8::1", "3fff::1"] {
        assert!(!permitted_addresses(&[first,SocketAddr::new(ip.parse().unwrap(),443)]));
    }
    assert!(!permitted_addresses(&[first;65]));
    for raw in ["https://a.example:443@else.example/", "https://a.example//../x", "https://a.example/%2f", "https://a.example/?q=1", "https://a.example/#x", "https://a.example:8443/", "http://a.example/path"] { assert!(endpoint("a.example",raw).is_none()); }
    assert!(endpoint("a.example","https://a.example:443/health/status.json").is_some());
}

#[tokio::test]
async fn real_pinned_socket_status_only_no_ambient_headers_or_redirect_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let host = "fixed-probe.invalid";
    let url = Url::parse(&format!("http://{host}:{}/health",address.port())).unwrap();
    let server = tokio::spawn(async move {
        for (code, location) in [(204,""),(307,"Location: /redirected\r\n")] {
            let (mut client,_) = listener.accept().await.unwrap();
            let mut data=Vec::new();
            while !data.ends_with(b"\r\n\r\n") { let mut byte=[0u8]; client.read_exact(&mut byte).await.unwrap(); data.push(byte[0]); assert!(data.len()<4096); }
            let headers=String::from_utf8(data).unwrap().to_ascii_lowercase();
            assert!(headers.starts_with("head /health http/1.1\r\n"));
            assert!(!headers.contains("cookie:") && !headers.contains("authorization:"));
            client.write_all(format!("HTTP/1.1 {code} Fixture\r\n{location}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        }
        assert!(tokio::time::timeout(Duration::from_millis(150), listener.accept()).await.is_err());
    });
    let client=pinned(host,&[address]).build().unwrap();
    assert_eq!(head(client.clone(),url.clone(),&[address]).await,Some(204));
    assert!(head(client,url,&[address]).await.is_none());
    server.await.unwrap();
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
#[ignore="run scripts/test-sync360-task-probe-tls.mjs with the Rust test executable"]
async fn offline_tls_quickjs_fixture() {
    use super::super::{sandbox, store, types::TaskPlugin};
    use serde_json::json;
    use std::{collections::BTreeMap, path::Path};
    let directory=std::env::var("TASK_FIXTURE_DIR").unwrap();
    store::install(Some(crate::server::db::Db::open(&Path::new(&directory).join("fixture.db")).unwrap()));
    const DOMAIN: &str="status.fixture.invalid";
    let fixture = |domain: &str, raw: &str, _: Instant, authorized: &dyn Fn()->bool| {
        if !authorized() { return None; }
        let address=std::env::var("TASK_FIXTURE_ADDR").ok()?.parse::<SocketAddr>().ok()?;
        if !address.ip().is_loopback() { return None; }
        let mut url=endpoint(domain,raw)?;
        url.set_port(Some(address.port())).ok()?;
        let ca=std::fs::read(Path::new(&std::env::var("TASK_FIXTURE_DIR").ok()?).join("ca.pem")).ok()?;
        let client=pinned(domain,&[address]).https_only(true).add_root_certificate(reqwest::Certificate::from_pem(&ca).ok()?).build().ok()?;
        tokio::runtime::Handle::current().block_on(head(client,url,&[address])).filter(|_| authorized())
    };
    for (id, path, script, expected) in [
        ("good","/health", "const code=await ctx.http.status('status.fixture.invalid'); if(code!==204) throw Error(); let blocked=false; try {await ctx.http.status('status.fixture.invalid')} catch {blocked=true} if(!blocked) throw Error();",true),
        ("jump","/jump","await ctx.http.status('status.fixture.invalid');",false),
        ("args","/health","await ctx.http.status('status.fixture.invalid','/other');",false),
    ] {
        let definition: TaskPlugin = serde_json::from_value(json!({"id":id,"name":id,"domains":[DOMAIN],"enabled":false,"scriptBody":format!("async function onSchedule(ctx) {{{script}}}")})).unwrap();
        let installed=store::create_plugin(definition).unwrap();
        let grants=BTreeMap::from([(DOMAIN.to_owned(),format!("https://{DOMAIN}{path}"))]);
        let plugin=store::patch_plugin(id,Some(true),None,Some(&grants),Some(installed.updated_at)).unwrap();
        let job=store::save_job(store::JobUpsertInput {id:None,plugin_id:id.into(),name:id.into(),cron_expression:"0 9 * * *".into(),timezone:"UTC".into(),timeout_seconds:8,proxy_id:String::new(),enabled:false,values:Default::default(),clear_secrets:vec![]}).unwrap();
        let input=sandbox::SandboxInput {plugin,job_id:job.id,job_name:job.name,trigger:"manual".into(),action_id:None,form_values:Default::default(),initial_storage:Default::default(),proxy_id:String::new(),timeout_seconds:8,preview_mode:false,abort:Default::default()};
        let result=tokio::task::spawn_blocking(move || sandbox::run_with_probe(&input, Instant::now(), fixture)).await.unwrap();
        assert_eq!(result.success,expected,"{id}: {:?}",result.error);
    }
}
