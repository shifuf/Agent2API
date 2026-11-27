use super::*;
use axum::{
    body::Bytes,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;

fn started(settings: &Settings, provider: Provider, session: Option<&str>) -> Pending {
    let start = start(
        settings,
        provider,
        "fixture-admin".into(),
        session.map(str::to_owned),
    )
    .unwrap();
    let url = url::Url::parse(&start.url).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let browser = start
        .cookie
        .split_once('=')
        .unwrap()
        .1
        .split(';')
        .next()
        .unwrap();
    let wrong = if provider == Provider::Github {
        Provider::Google
    } else {
        Provider::Github
    };
    assert!(take(wrong, &params["state"], browser, &settings.origin, session).is_err());
    assert!(take(
        provider,
        &params["state"],
        &random().unwrap(),
        &settings.origin,
        session
    )
    .is_err());
    if session.is_some() {
        assert!(take(
            provider,
            &params["state"],
            browser,
            &settings.origin,
            Some("another session")
        )
        .is_err());
    }
    let flow = take(
        provider,
        &params["state"],
        browser,
        &settings.origin,
        session,
    )
    .unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(flow.verifier.as_bytes())),
        params["code_challenge"]
    );
    assert!(take(
        provider,
        &params["state"],
        browser,
        &settings.origin,
        session
    )
    .is_err());
    flow
}

#[tokio::test]
async fn mock_identity_provider_binds_only_subject_and_current_admin_revision() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app=Router::new().route("/token",post(|body:Bytes|async move{let form:HashMap<_,_>=url::form_urlencoded::parse(&body).into_owned().collect();assert_eq!(form["grant_type"],"authorization_code");assert_eq!(form["client_secret"],"fixture-secret");assert!(form["redirect_uri"].starts_with("https://panel.test/api/panel/oauth/"));assert_eq!(form["code_verifier"].len(),43);Json(json!({"access_token":form["code"],"token_type":"Bearer"}))})).route("/profile",get(|headers:HeaderMap|async move{let original=headers.get("authorization").unwrap()=="Bearer original";Json(json!({"sub":if original{"google-subject"}else{"other-subject"},"id":if original{728}else{729},"email":"same@example.test","email_verified":true,"login":"same"}))}));
    let fixture = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for provider in [Provider::Github, Provider::Google] {
        let mut settings = Settings {
            origin: "https://panel.test".into(),
            revision: random().unwrap(),
            ..Default::default()
        };
        let client = settings.client_mut(provider);
        client.enabled = true;
        client.client_id = "fixture".into();
        client.secret = "fixture-secret".into();
        assert!(start(&settings, provider, "fixture-admin".into(), None).is_err());
        let bind = started(&settings, provider, Some("admin session"));
        let subject = exchange(
            &bind,
            settings.client(provider),
            "original",
            &format!("{base}/token"),
            &format!("{base}/profile"),
        )
        .await
        .unwrap();
        assert!(
            super::super::authorize_subject(&mut settings, &bind, &subject, "fixture-admin")
                .unwrap()
        );
        let login = started(&settings, provider, None);
        let same = exchange(
            &login,
            settings.client(provider),
            "original",
            &format!("{base}/token"),
            &format!("{base}/profile"),
        )
        .await
        .unwrap();
        assert!(
            !super::super::authorize_subject(&mut settings, &login, &same, "fixture-admin")
                .unwrap()
        );
        let another = exchange(
            &login,
            settings.client(provider),
            "other",
            &format!("{base}/token"),
            &format!("{base}/profile"),
        )
        .await
        .unwrap();
        assert!(
            super::super::authorize_subject(&mut settings, &login, &another, "fixture-admin")
                .is_err()
        );
        assert!(
            super::super::authorize_subject(&mut settings, &login, &same, "replaced-admin")
                .is_err()
        );
        settings.revision = random().unwrap();
        assert!(
            super::super::authorize_subject(&mut settings, &login, &same, "fixture-admin").is_err()
        );
    }
    fixture.abort();
}
