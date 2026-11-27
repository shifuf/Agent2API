// Isolated gateway + real HTTP WebDAV regression. No production requests.
import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from "node:timers/promises";
import { createFixturePanelSession } from './fixtures/panel-session.mjs';
const exe = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(os.tmpdir(), "agent2api-cloud-daily-"));
const provider = process.env.CLOUD_PROVIDER === "s3" ? "s3" : "webdav";
let failUploads = false,
  failHistoryCommit = false,
  failHistoryMarker = false,
  loseHistoryCommitResponse = false,
  failHistoryRead = false,
  failReadAfterCommit = false;
const fixtureSigningValue = "local-fixture-signing-value";
const key = "isolated-cloud-daily-admin",
  files = new Map(),
  ops = [],
  passed = [],
  failed = [];
let proc,
  output = "",
  base, panelToken;

const escapeXml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const uriEncode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function verifyS3Request(req, url, body) {
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=fixture-id\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
      req.headers.authorization || "",
    );
  if (!parsed) return false;
  const [, scope, signed, signature] = parsed;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  if (req.headers["x-amz-content-sha256"] !== bodyHash) return false;
  const names = signed.split(";");
  const headers = names
    .map((n) => n + ":" + String(req.headers[n] || "").trim() + "\n")
    .join("");
  const pairs = [...url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const query = pairs.map(([k, v]) => k + "=" + v).join("&");
  const canonical = [
    req.method,
    url.pathname,
    query,
    headers,
    signed,
    bodyHash,
  ].join("\n");
  const timestamp = req.headers["x-amz-date"];
  const [date, region, service, last] = scope.split("/");
  if (region !== "test-region" || service !== "s3" || last !== "aws4_request")
    return false;
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  const signing = hmac(
    hmac(hmac(hmac("AWS4" + fixtureSigningValue, date), region), "s3"),
    "aws4_request",
  );
  const text =
    "AWS4-HMAC-SHA256\n" +
    timestamp +
    "\n" +
    scope +
    "\n" +
    createHash("sha256").update(canonical).digest("hex");
  return createHmac("sha256", signing).update(text).digest("hex") === signature;
}

const dav = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const parsed = new URL(req.url, "http://local");
  if (
    provider === "s3" &&
    !verifyS3Request(req, parsed, Buffer.concat(chunks))
  ) {
    res.writeHead(403);
    res.end("invalid signature");
    return;
  }
  const p = decodeURIComponent(parsed.pathname).replace(/^\/bucket(?=\/)/, "");
  ops.push({ method: req.method, path: p });
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method === "GET" && parsed.searchParams.get("list-type") === "2") {
    const prefix = parsed.searchParams.get("prefix") || "";
    const cursor = parsed.searchParams.get("continuation-token");
    const offset = cursor
      ? Number(/^page:(\d+) &\+中文$/.exec(cursor)?.[1] ?? NaN)
      : 0;
    if (!Number.isSafeInteger(offset)) {
      res.writeHead(400);
      res.end("bad cursor");
      return;
    }
    const keys = [...files.keys()]
      .map((k) => k.slice(1))
      .filter((k) => k.startsWith(prefix))
      .sort();
    const part = keys.slice(offset, offset + 2);
    const more = offset + 2 < keys.length;
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(
      "<ListBucketResult><IsTruncated>" +
        more +
        "</IsTruncated>" +
        part
          .map((k) => "<Contents><Key>" + escapeXml(k) + "</Key></Contents>")
          .join("") +
        (more
          ? "<NextContinuationToken>" +
            escapeXml("page:" + (offset + 2) + " &+中文").replaceAll(
              "+",
              "&#43;",
            ) +
            "</NextContinuationToken>"
          : "") +
        "</ListBucketResult>",
    );
    return;
  }
  if (req.method === "PROPFIND") {
    if (req.headers.depth === "1") {
      const entries = new Map([[p, true]]);
      for (const k of files.keys()) {
        if (!k.startsWith(p) || k === p) continue;
        const relative = k.slice(p.length);
        const slash = relative.indexOf("/");
        if (slash < 0) entries.set(k, false);
        else entries.set(p + relative.slice(0, slash) + "/", true);
      }
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
          [...entries]
            .map(
              ([k, collection]) =>
                "<d:response><d:href>" +
                escapeXml(k) +
                "</d:href><d:propstat><d:prop><d:resourcetype>" +
                (collection ? "<d:collection/>" : "") +
                "</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
            )
            .join("") +
          "</d:multistatus>",
      );
    } else {
      res.writeHead(207);
      res.end('<d:multistatus xmlns:d="DAV:"/>');
    }
    return;
  }
  if (req.method === "MKCOL") {
    res.writeHead(201);
    res.end();
    return;
  }
  if (
    req.method === "PUT" &&
    (failUploads ||
      (failHistoryCommit &&
        /\/history\/\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(p)) ||
      (failHistoryMarker &&
        /\/history\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\/manifest\.json$/.test(p)))
  ) {
    res.writeHead(503);
    res.end("fixture outage");
    return;
  }
  if (req.method === "PUT") {
    files.set(p, Buffer.concat(chunks));
    if (
      loseHistoryCommitResponse &&
      /\/history\/\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(p)
    ) {
      failHistoryRead = failReadAfterCommit;
      req.socket.destroy();
      return;
    }
    res.writeHead(201);
    res.end();
    return;
  }
  if (req.method === "GET") {
    if (
      failHistoryRead &&
      /\/history\/\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(p)
    ) {
      res.writeHead(503);
      res.end("fixture history read outage");
      return;
    }
    if (!files.has(p)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(files.get(p));
    return;
  }
  if (req.method === "DELETE") {
    for (const k of files.keys())
      if (
        k === p ||
        (provider === "webdav" && k.startsWith(p.endsWith("/") ? p : p + "/"))
      )
        files.delete(k);
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(405);
  res.end();
});
dav.listen(0, "127.0.0.1");
await once(dav, "listening");
async function ok(
  endpoint,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + endpoint, {
    method,
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(panelToken ? {'x-panel-token':panelToken} : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const v = await r.json();
  assert.equal(r.status, 200, endpoint + ": " + JSON.stringify(v));
  return v.success && Object.hasOwn(v, "data") ? v.data : v;
}
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(50);
  }
  throw Error("timeout");
}
async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log("PASS " + name);
  } catch (e) {
    failed.push({ name, error: e.stack });
    console.error("FAIL " + name + ": " + e.message);
  }
}
const manifests = () =>
  ops.filter(
    (o) =>
      o.method === "PUT" &&
      o.path === "/agent2api-sync/v1/default/manifest.json",
  ).length;
async function start(home=root, accountKey='5'.repeat(64)) {
  panelToken=null;
  const portServer = http.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  base = "http://127.0.0.1:" + port;
  const env = {
    ...process.env,
    AGENT2API_PROXY_HOME: home,
    AGENT2API_HOST: "127.0.0.1",
    AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: key,
    AGENT2API_ACCOUNT_KEY: accountKey,
    AGENT2API_CAPTCHA_ENABLED: "0",
    AGENT2API_SELF_UPDATE: "0",
    AGENT2API_PANEL_PORT: "",
    AGENT2API_ADMIN_USER: "",
    AGENT2API_ADMIN_PASSWORD: "",
    AGENT2API_ADMIN_PASSWORD_HASH: "",
  };
  if(!accountKey)delete env.AGENT2API_ACCOUNT_KEY;
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    delete env[k];
  proc = spawn(exe, [], {
    cwd: home,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [proc.stdout, proc.stderr])
    s.on("data", (b) => (output = (output + b).slice(-160000)));
  await until(() => ok("/api/cloud-sync"));
}
async function stop() {
  if (proc && proc.exitCode === null) {
    const end = once(proc, "exit");
    proc.kill();
    await end;
  }
}
async function checkKeyImport(config) {
  const incoming=Buffer.from('5'.repeat(64),'hex');
  const settings={...config,autoSync:false};
  const payload={password:config.syncPassword};
  for(const mode of ['different-file','same-file','different-env','same-env','fresh']){
    await stop();const home=await mkdtemp(path.join(root,mode+'-'));const keyPath=path.join(home,'account.key');const file=mode==='different-file'?Buffer.alloc(32,119):mode==='same-file'?incoming:null;
    if(file)await writeFile(keyPath,file);
    await start(home,mode==='same-env'?'5'.repeat(64):mode==='different-env'?'8'.repeat(64):null);
    const credentials={username:'cloud-key-fixture',password:randomUUID()+'aA!'};panelToken=(await createFixturePanelSession(base,credentials)).accessToken;
    await ok('/api/cloud-sync',settings,'PUT');
    const word='local-only-'+randomUUID();
    if(mode==='fresh')assert.ok(!(await readdir(home)).includes('account.key'),'blank deployment must not need a pre-generated key');
    else {
      await ok('/api/privacy',{enabled:true,words:[word]},'PUT');
      await ok('/api/notifications',{enabled:false,channels:{webhook:{enabled:true,url:`http://127.0.0.1:1/${word}`}}},'PUT');
      await ok('/api/captcha/turnstile',{provider:'turnstile',siteKey:'fixture-site',secret:word,widgetOrigin:'https://fixture.invalid',hostnames:['fixture.invalid']},'PUT');
      await ok('/api/panel-oauth',{origin:'https://panel.fixture.invalid',provider:'github',clientId:'fixture-client',secret:word,enabled:true},'PUT');
      const db=new DatabaseSync(path.join(home,'agent2api.db'));try {
        const saved=key=>JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(key).value).settingsEnc;
        db.prepare("INSERT INTO task_plugins(id,name,enabled,created_at,updated_at) VALUES ('import-fixture','Fixture',0,0,0)").run();
        db.prepare("INSERT INTO task_jobs(id,plugin_id,name,cron_expression,enabled,secrets_enc,storage_enc,created_at,updated_at) VALUES ('job','import-fixture','Fixture','0 9 * * *',0,?,?,0,0)").run(saved('panelOauth'),saved('panelTurnstile'));
      }finally{db.close()}
    }
    const response=await fetch(base+'/api/cloud-sync/import-key',{method:'POST',headers:{'x-panel-token':panelToken,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,mode.startsWith('different')?400:200,mode+' must not replace any established local Accounts key');
    const files=await readdir(home);
    assert.ok(!files.some(name=>name.startsWith('account.key.bak')),mode+' must not move the current key');
    if(mode.endsWith('-env'))assert.ok(!files.includes('account.key'));
    else assert.deepEqual(await readFile(keyPath),file??incoming);
    if(mode!=='fresh'){
      const preview=await ok('/api/privacy/test',{text:word});assert.ok(!JSON.stringify(preview).includes(word));
      assert.equal((await ok('/api/notifications')).channels.webhook.urlSet,true);
      assert.equal((await ok('/api/captcha/turnstile')).hasSecret,true);
      assert.equal((await ok('/api/panel-oauth')).github.hasSecret,true);
      const db=new DatabaseSync(path.join(home,'agent2api.db'));try{
        const job=db.prepare("SELECT secrets_enc,storage_enc FROM task_jobs WHERE id='job'").get();
        const actualKey=mode.endsWith('-env')?(mode==='same-env'?incoming:Buffer.alloc(32,136)):await readFile(keyPath);
        for(const envelope of Object.values(job)){assert.ok(envelope.startsWith('enc1:'));const data=Buffer.from(envelope.slice(5),'base64');const cipher=createDecipheriv('aes-256-gcm',actualKey,data.subarray(0,12));cipher.setAuthTag(data.subarray(-16));assert.ok(Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]).includes(word))}
      }finally{db.close()}
    }
    if(mode==='fresh'){const download=await ok('/api/cloud-sync/download',{});assert.equal(download.status,'downloaded');}
    console.log('PASS',provider,'Accounts key import',mode);
  }
}
try {
  await start();
  await ok("/api/custom-providers", {
    name: "daily fixture",
    protocol: "chat_completions",
    baseUrl: "http://127.0.0.1:1/v1",
    keyGroups: [
      {
        id: "main",
        name: "Main",
        apiKeys: ["fixture-one"],
        models: ["fixture"],
        enabled: true,
      },
    ],
  });
  const config = {
    provider,
    s3Endpoint: "http://127.0.0.1:" + dav.address().port,
    s3Bucket: "bucket",
    s3Region: "test-region",
    s3AccessKeyId: "fixture-id",
    s3SecretAccessKey: fixtureSigningValue,
    webdavBaseUrl: "http://127.0.0.1:" + dav.address().port,
    webdavUsername: "fixture",
    webdavPassword: "fixture",
    syncPassword: "fixture-daily-password",
    enabled: true,
    autoSync: true,
    autoSyncIntervalMinutes: 1,
    remoteRoot: "agent2api-sync",
    profile: "default",
  };
  await ok("/api/cloud-sync", config, "PUT");
  await ok("/api/cloud-sync/upload", {});
  if(process.argv.includes('--key-import-only'))await checkKeyImport(config);
  else {
  await delay(1500);
  await test("same-day routine settings changes do not upload again", async () => {
    const n = manifests();
    for (const timeout of [12, 13]) {
      await ok(
        "/api/routing",
        {
          routingFailoverBackoff: false,
          routingSink: false,
          routingBreakerEnabled: false,
          routingBreakerTimeoutSeconds: timeout,
        },
        "PUT",
      );
      await delay(1700);
    }
    assert.equal(manifests(), n);
  });
  await test("manual upload creates one current-day history and removes expired owned snapshots", async () => {
    const prefix = "/agent2api-sync/v1/default/history/";
    files.set(prefix + "2020-01-01/snapshot.json", Buffer.from("{}"));
    files.set(
      prefix + "2020-01-01/manifest.json",
      files.get("/agent2api-sync/v1/default/manifest.json"),
    );
    files.set(prefix + "notes/keep.txt", Buffer.from("keep"));
    await ok("/api/cloud-sync/upload", {});
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    assert(
      files.has(prefix + day + "/manifest.json"),
      "daily history manifest missing",
    );
    assert(
      !files.has(prefix + "2020-01-01/snapshot.json"),
      "expired snapshot remains",
    );
    assert(
      files.has(prefix + "notes/keep.txt"),
      "foreign history directory removed",
    );
  });
  await test("DAV cleanup never recursively removes an artifact-named directory", async () => {
    if (provider !== "webdav") return;
    const dir = "/agent2api-sync/v1/default/history/2019-01-01/";
    files.set(
      dir + "manifest.json",
      Buffer.from(files.get("/agent2api-sync/v1/default/manifest.json")),
    );
    files.set(
      dir + "snapshot.json/private.txt",
      Buffer.from("foreign directory content"),
    );
    await ok("/api/cloud-sync/upload", {});
    assert(
      files.has(dir + "snapshot.json/private.txt"),
      "artifact-named directory recursively deleted",
    );
  });
  await test("failed same-day history commit preserves previous recoverable snapshot", async () => {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const dir = "/agent2api-sync/v1/default/history/" + date + "/";
    const before = Buffer.from(files.get(dir + "manifest.json"));
    const manifest = JSON.parse(before);
    await ok("/api/routing", { routingBreakerTimeoutSeconds: 19 }, "PUT");
    failHistoryCommit = true;
    try {
      const r = await fetch(base + "/api/cloud-sync/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(r.status, 502);
      assert.deepEqual(files.get(dir + "manifest.json"), before);
      for (const [name, meta] of Object.entries(manifest.artifacts)) {
        const bytes = files.get(dir + name);
        assert(bytes, "committed artifact missing");
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          meta.sha256,
          "previous committed snapshot was overwritten",
        );
      }
    } finally {
      failHistoryCommit = false;
    }
    await ok("/api/cloud-sync/upload", {});
  });

  await test("failed generation marker upload preserves previous recoverable snapshot", async () => {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const dir = "/agent2api-sync/v1/default/history/" + date + "/";
    const before = Buffer.from(files.get(dir + "manifest.json"));
    await ok("/api/routing", { routingBreakerTimeoutSeconds: 20 }, "PUT");
    failHistoryMarker = true;
    try {
      const r = await fetch(base + "/api/cloud-sync/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(r.status, 502);
      assert.deepEqual(files.get(dir + "manifest.json"), before);
    } finally {
      failHistoryMarker = false;
    }
    await ok("/api/cloud-sync/upload", {});
  });
  for (const readUnavailable of [false, true])
    await test(
      "history commit response loss keeps referenced generation" +
        (readUnavailable ? " when re-read is unavailable" : ""),
      async () => {
        const date = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        const dir = "/agent2api-sync/v1/default/history/" + date + "/";
        await ok(
          "/api/routing",
          { routingBreakerTimeoutSeconds: readUnavailable ? 22 : 21 },
          "PUT",
        );
        loseHistoryCommitResponse = true;
        failReadAfterCommit = readUnavailable;
        try {
          const r = await fetch(base + "/api/cloud-sync/upload", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + key,
              "Content-Type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(20000),
          });
          assert.equal(r.status, 502);
          const current = JSON.parse(files.get(dir + "manifest.json"));
          for (const [name, meta] of Object.entries(current.artifacts)) {
            const bytes = files.get(dir + name);
            assert(bytes, "committed artifact deleted after response loss");
            assert.equal(
              createHash("sha256").update(bytes).digest("hex"),
              meta.sha256,
            );
          }
        } finally {
          loseHistoryCommitResponse = false;
          failHistoryRead = false;
          failReadAfterCommit = false;
        }
        await ok("/api/cloud-sync/upload", {});
      },
    );
  await test("saving the same target and same passwords does not upload again", async () => {
    const n = manifests();
    await ok("/api/cloud-sync", config, "PUT");
    await delay(5000);
    assert.equal(manifests(), n);
  });
  await test("downloaded baseline without prior upload is not immediately uploaded back", async () => {
    await ok("/api/cloud-sync", { ...config, autoSync: false }, "PUT");
    await stop();
    await promisify(execFile)(
      process.env.CLOUD_TEST_PYTHON,
      [
        "-c",
        "import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);s=json.loads(db.execute('SELECT value FROM kv WHERE key=?',('cloudSync',)).fetchone()[0]);s['status']['lastUpload']=None;s['status']['syncBaselines']={};db.execute('UPDATE kv SET value=? WHERE key=?',(json.dumps(s),'cloudSync'));db.commit();db.close()",
        path.join(root, "agent2api.db"),
      ],
      { windowsHide: true },
    );
    await start();
    const n = manifests();
    await ok("/api/cloud-sync/download", {});
    await ok("/api/cloud-sync", config, "PUT");
    await delay(5000);
    assert.equal(manifests(), n);
  });

  await test("downloading a remote snapshot without key preserves local-key daily baseline", async () => {
    await ok("/api/cloud-sync", { ...config, autoSync: false }, "PUT");
    const manifestPath = "/agent2api-sync/v1/default/manifest.json";
    const original = Buffer.from(files.get(manifestPath));
    const noKey = JSON.parse(original);
    noKey.keyFingerprint = null;
    delete noKey.artifacts["account.key.enc"];
    noKey.snapshotId = createHash("sha256")
      .update(
        Object.entries(noKey.artifacts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, m]) => n + ":" + m.sha256)
          .join("|"),
      )
      .digest("hex");
    files.set(manifestPath, Buffer.from(JSON.stringify(noKey)));
    try {
      const n = manifests();
      await ok("/api/cloud-sync/download", {});
      await ok("/api/cloud-sync", config, "PUT");
      await delay(5000);
      assert.equal(manifests(), n);
    } finally {
      files.set(manifestPath, original);
      await ok("/api/cloud-sync/upload", {});
    }
  });
  await test("new account triggers exactly one same-day update", async () => {
    const n = manifests();
    await ok("/api/custom-providers", {
      name: "daily new account",
      protocol: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      keyGroups: [
        {
          id: "main",
          name: "Main",
          apiKeys: ["fixture-two"],
          models: ["fixture"],
          enabled: true,
        },
      ],
    });
    await until(() => manifests() > n);
    await delay(1700);
    assert.equal(manifests(), n + 1);
  });
  await test("restart preserves daily success and does not upload again", async () => {
    const n = manifests();
    await stop();
    await start();
    await ok("/api/routing", { routingBreakerTimeoutSeconds: 14 }, "PUT");
    await delay(2200);
    assert.equal(manifests(), n);
  });
  await test("failed uploads back off rather than repeating for each data change", async () => {
    failUploads = true;
    await ok("/api/custom-providers", {
      name: "outage new account",
      protocol: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      keyGroups: [
        {
          id: "main",
          name: "Main",
          apiKeys: ["fixture-three"],
          models: ["fixture"],
          enabled: true,
        },
      ],
    });
    await until(
      async () =>
        (await ok("/api/cloud-sync")).status.lastErrorSource === "auto",
    );
    const n = ops.filter((o) => o.method === "PUT").length;
    await ok("/api/routing", { routingBreakerTimeoutSeconds: 15 }, "PUT");
    await delay(1700);
    assert.equal(ops.filter((o) => o.method === "PUT").length, n);
    failUploads = false;
  });
  await test("changing target bypasses failure backoff and saves a separate daily state", async () => {
    const n = ops.length;
    await ok("/api/cloud-sync", { ...config, profile: "other" }, "PUT");
    await until(() =>
      ops
        .slice(n)
        .some(
          (o) =>
            o.method === "PUT" &&
            o.path === "/agent2api-sync/v1/other/manifest.json",
        ),
    );
    await until(
      async () =>
        (await ok("/api/cloud-sync")).status.lastUpload.accountIds.length === 3,
      20000,
    );
    const state = await ok("/api/cloud-sync");
    assert(state.status.lastUpload.scope);
    assert.equal(state.status.lastUpload.accountIds.length, 3);
  });

  await test("switching A to B then restarting and returning to A keeps each target daily baseline", async () => {
    await ok("/api/cloud-sync", config, "PUT");
    await ok("/api/cloud-sync/upload", {});
    await ok("/api/cloud-sync", { ...config, profile: "other" }, "PUT");
    await delay(5000);
    await stop();
    await start();
    const n = manifests();
    await ok("/api/cloud-sync", config, "PUT");
    await delay(5000);
    assert.equal(manifests(), n);
    await ok("/api/cloud-sync", { ...config, profile: "other" }, "PUT");
    await delay(1500);
  });
  await test("next calendar day uploads without any account or configuration change", async () => {
    if (!process.env.CLOUD_TEST_PYTHON)
      throw Error("CLOUD_TEST_PYTHON missing");
    await stop();
    const old = ops.filter(
      (o) =>
        o.method === "PUT" &&
        o.path === "/agent2api-sync/v1/other/manifest.json",
    ).length;
    await promisify(execFile)(
      process.env.CLOUD_TEST_PYTHON,
      [
        "-c",
        "import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);s=json.loads(db.execute('SELECT value FROM kv WHERE key=?',('cloudSync',)).fetchone()[0]);s['status']['lastUpload']['uploadedAt']-=86400000;s['status']['syncBaselines']={k:{**v,'uploadedAt':v['uploadedAt']-86400000} for k,v in s['status'].get('syncBaselines',{}).items()};db.execute('UPDATE kv SET value=? WHERE key=?',(json.dumps(s),'cloudSync'));db.commit();db.close()",
        path.join(root, "agent2api.db"),
      ],
      { windowsHide: true },
    );
    await start();
    await until(
      () =>
        ops.filter(
          (o) =>
            o.method === "PUT" &&
            o.path === "/agent2api-sync/v1/other/manifest.json",
        ).length > old,
    );
    await delay(1700);
    assert.equal(
      ops.filter(
        (o) =>
          o.method === "PUT" &&
          o.path === "/agent2api-sync/v1/other/manifest.json",
      ).length,
      old + 1,
    );
  });
  }
} finally {
  await stop();
  dav.closeAllConnections();
  await new Promise((r) => dav.close(r));
  await writeFile(path.join(root, "server.log"), output);
  await writeFile(
    path.join(root, "results.json"),
    JSON.stringify({ passed, failed, ops }, null, 2),
  );
  console.log(root);
}
if (failed.length) process.exitCode = 1;
