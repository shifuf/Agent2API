import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE })
const origin = 'https://widget.example.test'
try {
  const page = await browser.newPage()
  await page.route('https://panel.example.test/', route => route.fulfill({ contentType:'text/html',body:`<iframe title="verification" sandbox="allow-scripts allow-same-origin" src="${origin}/turnstile-widget.html#0123456789abcdef0123456789abcdef" onload="const channel=new MessageChannel();channel.port1.onmessage=({data})=>{document.title=data.state==='verified'&&typeof data.token==='string'&&data.token.length>0?'verified':'error'};this.contentWindow.postMessage({channel:'0123456789abcdef0123456789abcdef',siteKey:'1x00000000000000000000AA'},'${origin}',[channel.port2])"></iframe>` }))
  await page.route(origin + '/turnstile-widget.html', route => route.fulfill({contentType:'text/html',path:resolve(import.meta.dirname,'../desktop-tauri/src-tauri/server/src/server/api/turnstile-widget.html')}))
  await page.goto('https://panel.example.test/')
  await page.waitForFunction(()=>document.title==='verified'||document.title==='error',null,{timeout:90_000})
  assert.equal(await page.title(),'verified')
  console.log('PASS live Cloudflare public test sitekey, real SDK / challenge frame in an isolated HTTPS widget origin (browser token only; not production siteverify)')
} finally { await browser.close() }
