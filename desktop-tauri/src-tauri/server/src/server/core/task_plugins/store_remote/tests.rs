use super::*;
use axum::{body::Body, extract::Request, http::Response, Router};
use ed25519_dalek::{Signer, SigningKey};
use std::{io::Write, sync::{Arc, atomic::{AtomicBool, Ordering}}};

const ID: &str = "sample-job";
const FILE: &str = "sample-job-1.0.0-task-script.zip";
const SCRIPT: &str = "/* @agent2api-task-plugin\n{\"id\":\"sample-job\",\"name\":\"Sample\",\"version\":\"1.0.0\"}\n*/\nexport async function onSchedule(ctx) { return 21; }";

fn package(key: &SigningKey, body: &str, claimed_script: &str, key_id: &str, name: &str) -> Vec<u8> {
    let signed = format!("task-script-v1\n{ID}\n1.0.0\n{:x}", Sha256::digest(claimed_script.as_bytes()));
    let manifest = json!({"id":ID,"version":"1.0.0","target":"task-script","signature":{"key_id":key_id,"algorithm":"ed25519","value":STANDARD.encode(key.sign(signed.as_bytes()).to_bytes())}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options=zip::write::SimpleFileOptions::default();
    zip.start_file("pack.json",options).unwrap(); zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.start_file(name,options).unwrap(); zip.write_all(body.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn feed(bytes: &[u8]) -> Value {
    let digest=format!("sha256:{:x}",Sha256::digest(bytes));
    json!({"schema":1,"plugins":[{"id":ID,"name":"Sample","category":"scheduled_task","icon":"https://agent2api.dev/plugin-assets/icon.svg","release":{"tag_name":"v1.0.0","assets":[{"name":FILE,"size":bytes.len(),"digest":digest,"browser_download_url":format!("https://agent2api.dev/downloads/plugins/{ID}/v1.0.0/{FILE}")}]}}]})
}

#[tokio::test]
async fn catalog_redirect_package_and_rejections_use_local_http() {
    let key = SigningKey::from_bytes(&[9u8;32]);
    let public: String = key.verifying_key().to_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
    let trusted = &[("test-only",public.as_str())];
    let bytes = package(&key,SCRIPT,SCRIPT,"test-only","script.js");
    let data = feed(&bytes);
    let cdn = format!("https://cdn.agent2api.dev/agent2api/plugins/{ID}/v1.0.0/{:x}/{FILE}",Sha256::digest(&bytes));
    let path = Url::parse(&cdn).unwrap().path().to_owned();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let bad_redirect = Arc::new(AtomicBool::new(false));
    let app=Router::new().fallback({
        let requests=requests.clone(); let data=data.clone(); let bytes=bytes.clone(); let bad_redirect=bad_redirect.clone();
        move |req: Request| {
            let requested=req.uri().path().to_owned(); requests.lock().unwrap().push(requested.clone());
            assert!(!req.headers().contains_key("authorization") && !req.headers().contains_key("cookie"));
            let response = if requested.ends_with("/catalog.json") { Response::new(Body::from(data.to_string())) }
                else if requested.starts_with("/downloads/plugins/") { Response::builder().status(302).header("location",if bad_redirect.load(Ordering::SeqCst) { "https://agent2api.dev/plugin-assets/icon.svg" } else { &cdn }).body(Body::empty()).unwrap() }
                else if requested==path { Response::new(Body::from(bytes.clone())) } else { panic!("unexpected request") };
            async move { response }
        }
    });
    let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin=Url::parse(&format!("http://{}",socket.local_addr().unwrap())).unwrap();
    let server=tokio::spawn(async move { axum::serve(socket,app).await.unwrap(); });
    let map=|url:&Url| origin.join(url.path()).unwrap();
    let http=Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let channels=config::UpdateChannels::default();
    let contents=fetch(&http,Url::parse(CATALOG).unwrap(),None,LIMIT,map).await.unwrap();
    let asset=parse_catalog(&contents,channels).unwrap().remove(0);
    let download=fetch(&http,asset.url.clone(),Some(&asset),asset.size,map).await.unwrap();
    let plugin=unpack(&download,&asset,trusted).unwrap();
    assert!(plugin.signed && !plugin.enabled && !plugin.notify_allowed && plugin.source=="official");
    assert!(unpack(&download,&asset,plugin_host::OFFICIAL_PUBKEYS).is_err());
    assert_eq!(requests.lock().unwrap().len(),3);
    bad_redirect.store(true,Ordering::SeqCst);
    assert!(fetch(&http,asset.url.clone(),Some(&asset),asset.size,map).await.is_err());
    assert_eq!(requests.lock().unwrap().len(),4);
    for url in ["https://agent2api.dev/downloads/app.zip", "https://cdn.agent2api.dev.example.invalid/downloads/plugins/a.zip", "http://127.0.0.1/", "https://agent2api.dev/plugin-assets/icon.svg"] {
        assert!(fetch(&http,Url::parse(url).unwrap(),Some(&asset),LIMIT,map).await.is_err());
    }
    assert_eq!(requests.lock().unwrap().len(),4);
    assert!(unpack(&bytes[1..],&asset,trusted).is_err());
    for invalid in [package(&key,SCRIPT,"not signed","test-only","script.js"),package(&key,SCRIPT,SCRIPT,"unknown","script.js"),package(&key,SCRIPT,SCRIPT,"test-only","../script.js"),package(&key,&SCRIPT.replace("1.0.0","2.0.0"),&SCRIPT.replace("1.0.0","2.0.0"),"test-only","script.js")] {
        let item=parse_catalog(&serde_json::to_vec(&feed(&invalid)).unwrap(),channels).unwrap().remove(0);
        assert!(unpack(&invalid,&item,trusted).is_err());
    }
    for (field,bad) in [("digest",Value::Null),("size",json!(0)),("browser_download_url",json!("https://agent2api.dev/plugin-assets/icon.svg"))] {
        let mut invalid=data.clone(); invalid["plugins"][0]["release"]["assets"][0][field]=bad;
        assert!(parse_catalog(&serde_json::to_vec(&invalid).unwrap(),channels).unwrap().is_empty());
    }
    let mut beta=data.clone(); beta["plugins"][0]["release"]["prerelease"]=json!(true);
    assert!(parse_catalog(&serde_json::to_vec(&beta).unwrap(),channels).unwrap().is_empty());
    server.abort();
}
