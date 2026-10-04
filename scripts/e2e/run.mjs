import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, chmod, lstat, rm, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
process.umask(0o077);
const origin = 'https://do1.musaraj.com';
const envPath = '.env.e2e.local';
const artifacts = root + '.e2e';
const runID = new Date().toISOString() + '-' + randomBytes(4).toString('hex');
const message = `Desktop Chat E2E ${runID}`;
const screenshotDir = `${artifacts}/runs/${runID.replaceAll(':', '-')}`;
const screens = [];
async function recordScreen(name, source) {
  const filename = `${String(screens.length + 1).padStart(2, '0')}-${name}.png`;
  await copyFile(source, `${screenshotDir}/${filename}`);
  screens.push({ name, filename });
  await writeFile(`${screenshotDir}/index.html`, `<!doctype html><meta charset="utf-8"><title>Discourse Chat E2E screens</title>
    <style>body{font:16px system-ui;background:#f4f5f7;color:#222;max-width:1200px;margin:40px auto;padding:0 20px}article{background:white;padding:20px;margin:24px 0;border-radius:12px}img{display:block;width:100%;height:auto}a{color:inherit}</style>
    <h1>Discourse Chat — test screens</h1><p>Run ${runID}. App images are webview PDF captures; browser images are Playwright screenshots. Temporary authorization codes expire with this test.</p>
    ${screens.map((screen, i) => `<article><h2>${i + 1}. ${screen.name.replaceAll('-', ' ')}</h2><a href="${screen.filename}"><img src="${screen.filename}" loading="lazy"></a></article>`).join('')}`);
}
async function browserSnapshot(name) {
  const path = `${artifacts}/${name}.png`;
  await page.screenshot({ path });
  await recordScreen(name, path);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let stage = 'initialization', browser, page, child, provisioned = false, locked = false;
const events = [];
let nativeErrors = '';
let credentials = {};
async function saveCredentials() {
  await writeFile(envPath + '.tmp', Object.entries(credentials).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join('\n') + '\n', { mode: 0o600 });
  await rename(envPath + '.tmp', envPath);
  await chmod(envPath, 0o600);
}
async function command(exe, args, { input, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', reject);
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${exe} failed (${code}): ${err.split('\n').slice(0,8).join(' ').slice(0,1500)}`)); });
    p.stdin.end(input);
  });
}
async function fixture(action, extra = {}) {
  const data = Buffer.from(JSON.stringify({ action, ...extra })).toString('base64');
  const ruby = `require 'base64'\nE2E = JSON.parse(Base64.decode64('${data}'))\n` + await readFile('scripts/e2e/fixture.rb', 'utf8');
  const out = await command('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=10','do-hermes','docker exec -i -u discourse -w /var/www/discourse do1 bundle exec rails runner -'], { input: ruby });
  const result = out.split('\n').find(l => l.startsWith('E2E_RESULT='));
  assert(result, 'No fixture result');
  return JSON.parse(result.slice(11));
}
async function waitEvent(type, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const i = events.findIndex(e => e.type === type);
    if (i !== -1) return events.splice(i, 1)[0].data;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Native app exited unexpectedly: ' + nativeErrors.slice(-1000));
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${type}`);
}
let sequence = 0;
async function appCommand(data) {
  await writeFile('.e2e/command.tmp', JSON.stringify({ id: ++sequence, ...data }));
  await rename('.e2e/command.tmp', '.e2e/command.json');
}
async function evaluate(expression) {
  await appCommand({ op: 'eval', code: `(async()=>{try{await tiny.api.call('e2eReport',{value:await (${expression})});}catch(e){await tiny.api.call('e2eReport',{error:String(e.message)});}})()` });
  const result = await waitEvent('report', 15000);
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function waitFor(expression, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(500);
  }
  const status = await evaluate(`JSON.stringify({ path:location.pathname, status:document.querySelector('#status')?.textContent, sessions:document.querySelector('#session-list')?.innerText })`);
  await snapshot('failure-app');
  throw new Error('Webview condition timed out: ' + status);
}
async function snapshot(name) {
  const path = `${artifacts}/${name}.pdf`;
  await appCommand({ op:'pdf', path });
  await waitEvent('pdf');
  await command('sips', ['-s','format','png', path, '--out', `${artifacts}/${name}.png`]);
  await recordScreen(name, `${artifacts}/${name}.png`);
}
try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await mkdir('.e2e/run.lock'); locked = true;
  await chmod(artifacts, 0o700);
  await mkdir(screenshotDir, { recursive:true, mode:0o700 });
  await rm('.e2e/result.json', { force:true });
  try {
    assert((await lstat(envPath)).isFile(), 'Credential file must be a regular file');
    process.loadEnvFile(envPath);
    credentials.E2E_PASSWORD = process.env.E2E_PASSWORD;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  credentials.E2E_PASSWORD ||= randomBytes(32).toString('base64url');
  await saveCredentials();
  if (process.argv.includes('--cleanup')) {
    stage = 'explicit fixture cleanup';
    await fixture('cleanup');
    console.log('Test-user sessions, API keys, and email login tokens revoked');
  } else {
  stage = 'provisioning private fixtures'; console.log(stage);
  const fixtureData = await fixture('setup', { password: credentials.E2E_PASSWORD });
  provisioned = true;
  credentials = { ...credentials, E2E_ORIGIN: origin, E2E_USERNAME: fixtureData.username, E2E_USER_ID: fixtureData.user_id, E2E_CHANNEL_ID: fixtureData.channel_id, E2E_BROWSER_COOKIE: fixtureData.browser_cookie };
  await saveCredentials();
  stage = 'building ephemeral native webview'; console.log(stage);
  await command('sh', ['scripts/e2e/build.sh']);
  await rm('.e2e/command.json', { force: true });
  stage = 'isolated browser session'; console.log(stage);
  browser = await chromium.launch({ headless: process.env.E2E_HEADED !== '1' });
  const context = await browser.newContext();
  await context.addCookies([{ name:fixtureData.cookie_name, value:fixtureData.browser_cookie, url:origin, secure:true, httpOnly:true, sameSite:'Lax' }]);
  page = await context.newPage();
  page.setDefaultTimeout(90000);
  await page.goto(origin, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => window.Discourse?.__container__?.lookup('service:current-user')?.username === 'chat_wrapper_e2e');
  await browserSnapshot('browser-existing-session');
  delete credentials.E2E_BROWSER_COOKIE; await saveCredentials();
  stage = 'starting native app'; console.log(stage);
  child = spawn(root + '.runtime/bin/tjs', ['run', root + 'scripts/e2e/app.js'], { cwd:root, env:{...process.env, TINYJS_DEBUG:'0'}, stdio:['ignore','pipe','pipe'] });
  createInterface({ input:child.stdout }).on('line', line => { if (line.startsWith('E2E:')) { try { events.push(JSON.parse(line.slice(4))); } catch {} } });
  child.stderr.on('data', d => { nativeErrors = (nativeErrors + d).slice(-4000); });
  await waitEvent('ready');
  await waitEvent('loaded');
  await waitFor(`document.querySelector('#connect') && !document.querySelector('#connect').disabled`);
  await snapshot('home');
  await evaluate(`(()=>{document.querySelector('#add-site').open=true;return true;})()`);
  await waitFor(`document.querySelector('#address').getBoundingClientRect().height > 0`);
  await evaluate(`(()=>{document.querySelector('#address').value=${JSON.stringify(origin)};return true;})()`);
  await snapshot('site-address-entered');
  await evaluate(`(()=>{document.querySelector('#picker').requestSubmit();return true;})()`);
  stage = 'browser device approval'; console.log(stage);
  const authURL = await waitEvent('browser');
  assert.equal(new URL(authURL).origin, origin);
  const code = await waitFor(`document.querySelector('#device-code')?.textContent || false`);
  await snapshot('waiting-for-browser-approval');
  await page.goto(authURL, { waitUntil:'domcontentloaded' });
  const inputs = page.locator('input.authorize-api-key__code-input');
  await inputs.first().waitFor();
  await browserSnapshot('browser-authorization');
  await inputs.first().pressSequentially(code.replace(/[^a-z0-9]/gi,''));
  await browserSnapshot('browser-code-entered');
  await page.locator('.authorize-api-key button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.authorize-api-key__code-form'));
  await browserSnapshot('browser-approved');
  stage = 'native OTP session and chat'; console.log(stage);
  await waitFor(`location.origin === ${JSON.stringify(origin)} && window.Discourse?.__container__?.lookup('service:current-user')?.username === 'chat_wrapper_e2e'`);
  await waitFor(`document.querySelector('.main-chat-outlet, #main-chat-outlet') && getComputedStyle(document.body).visibility !== 'hidden'`);
  await snapshot('chat-after-authentication');
  await evaluate(`(async()=>{await window.Discourse.__container__.lookup('service:router').transitionTo(${JSON.stringify(fixtureData.channel_url)});return true;})()`);
  await waitFor(`location.pathname === ${JSON.stringify(fixtureData.channel_url)} && document.querySelector('.chat-composer__input') && getComputedStyle(document.body).visibility !== 'hidden'`);
  assert.equal(await evaluate(`!!document.querySelector('.login-modal,.login-fullpage,#login-form')`), false);
  await snapshot('test-channel');
  stage = 'sending message through webview composer'; console.log(stage);
  await evaluate(`(()=>{const el=document.querySelector('.chat-composer__input');el.focus();el.value=${JSON.stringify(message)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor(`document.querySelector('.chat-composer .-send:not(:disabled)') !== null`);
  await snapshot('message-composed');
  await evaluate(`(()=>{document.querySelector('.chat-composer .-send:not(:disabled)').click();return true;})()`);
  await waitFor(`document.querySelector('.chat-composer__input')?.value === '' && document.body.innerText.includes(${JSON.stringify(message)})`);
  await snapshot('message-sent');
  stage = 'checking saved session on Home'; console.log(stage);
  await appCommand({ op:'home' });
  await waitEvent('home');
  await waitFor(`location.protocol === 'file:' && [...document.querySelectorAll('#session-list button')].some(b=>b.classList.contains('open-site') && !b.disabled)`);
  await snapshot('saved-session');
  await evaluate(`(()=>{document.querySelector('#add-site').open=true;return true;})()`);
  await snapshot('add-another-site');
  await evaluate(`(()=>{document.querySelector('#sessions').open=true;return true;})()`);
  await waitFor(`document.querySelector('#session-list button').getBoundingClientRect().height > 0`);
  await evaluate(`(()=>{document.querySelector('#session-list button').click();return true;})()`);
  await waitFor(`location.origin === ${JSON.stringify(origin)} && window.Discourse?.__container__?.lookup('service:current-user')?.username === 'chat_wrapper_e2e'`);
  await waitFor(`document.querySelector('.main-chat-outlet, #main-chat-outlet') && getComputedStyle(document.body).visibility !== 'hidden'`);
  await snapshot('reopened-chat');
  stage = 'verifying server message'; console.log(stage);
  const verified = await fixture('verify', { channel_id:fixtureData.channel_id, message });
  await writeFile('.e2e/result.json', JSON.stringify({ passed:true, runID, screenshots:screenshotDir, screen_count:screens.length, origin, username:fixtureData.username, ...verified, message, channel_url:origin + fixtureData.channel_url }, null, 2));
  console.log(`Screenshots: ${screenshotDir}/index.html`);
  console.log(`PASS: message ${verified.message_id}, channel ${verified.channel_id}, user ${verified.user_id}`);
  }
} catch (error) {
  if (locked) await writeFile('.e2e/result.json', JSON.stringify({ passed:false, runID, stage }, null, 2));
  await page?.screenshot({ path:artifacts + '/failure-browser.png', timeout:5000 }).catch(()=>{});
  // Playwright errors can include secret URLs. Limit output to the failing stage.
  console.error(`FAIL during ${stage}: ${String(error.message).replace(/https?:\/\/\S+/g,'[URL redacted]').replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').slice(0,900)}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    await appCommand({ op:'quit' }).catch(()=>{});
    await sleep(500); child.kill('SIGTERM');
  }
  await browser?.close();
  if (provisioned) {
    console.log('Revoking test-user sessions and temporary credentials');
    try { await fixture('cleanup'); } catch { console.error('Fixture cleanup failed; rerun npm run test:e2e:cleanup'); process.exitCode = 1; }
  }
  delete credentials.E2E_BROWSER_COOKIE;
  if (locked) { await saveCredentials(); await rm('.e2e/run.lock', { recursive:true }); }
}
