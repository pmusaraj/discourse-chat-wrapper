# Discourse Chat App

A macOS webview app for one Discourse chat site at a time. Requires macOS 15+
and Apple Silicon for the current local build.

## Run locally

```sh
npm run setup
npm start
```

Build and open the standalone app:

```sh
npm run build
open "dist/Discourse Chat App.app"
```

The runtime is pinned to TinyJS v0.42.3. Setup/build apply a small, reproducible
macOS patch from `native/chat-session.inc` using `scripts/build-runtime.sh`.
The first run downloads the pinned source archive, verifies its checksum, and
compiles the launcher. This requires Xcode Command Line Tools, Python 3, and
network access. No global runtime installation is changed. The launcher patch
adds backend-only Home navigation and session-cookie operations; neither is
exposed to remote pages. This local launcher build omits TinyJS's optional AI shim.

Builds use an available Apple Development signing identity, otherwise ad-hoc
signing. They are not notarized for distribution. The bundle identifier remains
`org.discourse.dev.chat.tinyjs.poc`, preserving existing WebKit session storage.

## Home and sessions

Every launch starts on Home in the main webview. Saved sites appear with a live
session status. **Open** becomes available only after the server confirms
a valid session; selecting the site checks again. Expired sessions show **Log in**
and “Re-authenticate with this site”; Log in starts browser authentication for
that site. Unreachable sites remain disabled. Sessions are checked automatically whenever Home opens.

Enter a site's main HTTPS address and click **Authenticate** to authenticate in
the default browser. Subfolder installations are not supported. This is the only
login option. Existing browser cookies, passkeys, and SSO work in the browser.
With saved sites, expand **Add a new site** to reveal an address form prefilled
with `https://`. It starts collapsed and resets to `https://` whenever reopened.
Without saved sites, Home shows introductory copy and expands **Add your first site**
automatically. Addresses entered without a scheme receive the `https://` prefix. Reauthenticating a
saved site keeps this form collapsed; approval controls appear separately.
**Your sites** and **Add a new site** are mutually exclusive disclosure sections.
Your sites starts expanded when saved sites exist.
There is no secondary picker window or Sites menu.

Use **Chat > Home** (Cmd+1) to return to the intro screen without logging out.
**Chat > Desktop Notifications** toggles the saved notification preference.
Authentication errors appear in the webview. **Chat > Log Out** ends the selected WebKit session,
retains the saved site for reauthentication, and returns Home. Failed logout preserves the session
and reports an error on Home. Logout follows the site’s session policy and does not clear the external browser’s
cookies or an identity provider’s session.

The app blocks site login/authentication navigations and returns Home when a
session expires. Remote page content remains covered until Discourse has an
authenticated current user and renders chat. Recovery offers Home and Retry;
it never offers to reveal the site's login screen.

## Temporary Dev menu

- **Remove All Sessions and Sites** clears this app’s WebKit website data and saved
  site list, returning it to the initial Home screen. It does not clear browser data.
- **Log Out All Sites** sends CSRF-protected logout requests for saved sites and
  removes their local cookies, retaining the site list for reauthentication.
- **Log Out Current Site** does the same for the open chat site.
- **Test Notification in 5 Seconds** requests macOS notification permission and
  sends a diagnostic notification, including from Home. This explicit test bypasses
  the app’s notification toggle and focus suppression; macOS still controls delivery.

Dev reset/logout waits for existing native session checks to finish before changing
cookies. Unreachable sites are reported on Home so logout failures can be retried.

## Browser authentication

Sites advertising `Auth-Api-Device-Code: true` use device authorization: the app
displays a code, opens the site's approval page in the default browser, and polls
for approval at the server's interval, backing off after rate limits.

Other sites use the same browser authentication action with a paste fallback:
approve access, copy the encrypted authorization code shown by Discourse, paste
it into Home, and click **Continue to chat**.

Both flows request a temporary `write` API key to call `/user-api-key/otp.json`.
Discourse disallows `one_time_password` scope in device authorization; that scope
also does not authorize the POST exchange endpoint. The key is revoked after the
exchange, including on exchange failures. Revocation failures are logged; unused
keys can be removed in the site's Apps preferences. Cancellation before the app
receives a key cannot revoke an authorization already issued in the browser.

Native code uses an ephemeral network session seeded only with the selected
site's WebKit cookies. It obtains a CSRF token, POSTs the one-time login token,
verifies `/session/current.json`, and copies the session cookies back into WebKit
before opening chat. It never displays the site's login or OTP confirmation UI.
Redirects are not followed. The expected OTP response must point to the same
site's root; external redirects fail closed. Session checks distinguish expired
authentication from network/server failures.

No browser callback handler is registered. `discourse://auth_redirect` is only
a server-validated parameter for the JSON OTP exchange; the app never opens it.
Sites must allow this address, User API keys, `write` scope, one-time passwords,
and OAEP encryption. Unsupported sites show an error rather than embedded login.

Pending authorization expires within ten minutes and exists only in memory.
Each attempt uses RSA-2048/OAEP-SHA1 and a random nonce. Private keys, API keys,
and one-time tokens are not persisted or logged. WebKit owns persistent session
cookies. Preferences contain only site addresses, notification preference, and
an installation-specific client ID. Only the local main webview can select a
site or initiate authentication.

## Chat and validation

The injected layout removes the site header and forum sidebar on chat routes.
Forum topics, profiles, and external links open in the default browser. The chat
notification listener uses Discourse's current-user and MessageBus services;
notifications are scoped to the selected site and suppressed while focused.

```sh
npm test
sh scripts/test-native.sh
```

JavaScript checks cover browser authentication, session selection, Home,
expiration, navigation guards, and notifications. Native tests exercise cookie
isolation, CSRF/OTP handoff, session validation, and rejection of redirects using
mock responses. These do not establish that live authentication works on every
Discourse installation.

Manual acceptance:

1. Launch with saved cookies: confirm Home appears and checks the listed sites.
2. Open a valid session, return Home, and choose another site.
3. Authenticate a new site in the browser; chat should open without a login form.
4. Cancel/retry authentication; test an expired session and an unreachable site.
5. Quit/reopen: Home should appear again and the valid session remain selectable.
6. Log out and confirm the site disappears from the saved list.

The icon in `assets/discourse-chat.svg` adapts the
[Discourse logo](https://www.discourse.org/a/img/logo-icon.svg) with typing dots
and a macOS icon tile. `assets/discourse-chat.png` is the build input.

## Live end-to-end test (do1)

This opt-in macOS test uses `do1.musaraj.com` in the `do1` container on SSH host
`do-hermes`. It creates the nonstaff `chat_wrapper_e2e` account and a private
**Chat Wrapper E2E** category/channel, accessible to its test group and staff.
It does not change the site's login settings or send email. Each run leaves one
uniquely labeled message in that channel for inspection.

Prerequisites: Node 24+, the local runtime (`npm run setup`), Xcode Command Line
Tools, Python 3, a logged-in macOS desktop, and working `ssh do-hermes` access.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Use `E2E_HEADED=1 npm run test:e2e` to watch the separate Chromium window. The
native app window is visible in either mode. This is a live integration test;
`npm test` remains the offline unit suite.

The test provisions a valid encrypted session cookie over SSH and seeds it in
a fresh browser context for the fixture user (do1 disables local login). It clicks
**Authenticate** in the actual app Home, enters the device code in Chromium,
and approves access. Production authentication code then polls, exchanges the
key for a native WebKit session, and revokes the temporary API key. The driver
types and submits a message using the webview composer, checks Home's saved
session and **Open**, and verifies the message's author/content/channel on the
server. It exercises browser approval and the real native cookie handoff;
it substitutes isolated Chromium for the OS default browser and starts with a
provisioned browser session. It does not test initial login, SSO, email delivery,
or default-browser launching.

Credentials are generated in `.env.e2e.local`, with owner-only permissions
(`0600`), and excluded by `.gitignore`. Never force-add this file. The temporary browser
cookie is removed from the file after seeding the browser. `.e2e/` is also ignored and private; it contains
build output, screenshots (`home.png`, `message-sent.png`, `saved-session.png`,
`browser-approved.png`), and `result.json`. Each run also saves every captured
app/browser screen in chronological order under `.e2e/runs/<run-id>/`, with an
`index.html` gallery. The gallery includes the initial browser session, Home,
site address, pending approval, browser authorization and code entry, approval
confirmation, chat, message composition/send, saved session, expanded Add Site,
and reopened chat. App captures are exported from the webview as PDF/PNG;
browser captures use Playwright. Do not enable full TinyJS protocol
tracing during authentication; it can contain credentials.

The test compiles a disposable copy of the native launcher with a nonpersistent
WK data store and uses in-memory app preferences. Your normal app's sessions
and browser profile are untouched. Runs are serialized with `.e2e/run.lock`.
Test-only driver APIs are absent from the production app.

On success or failure, the runner closes the test app/browser and revokes all
sessions, API keys, and email-login tokens belonging to this dedicated user.
The user, private channel, and messages remain reusable. After a forced kill,
ensure no test is running, remove the stale `.e2e/run.lock` directory, then run:

```sh
npm run test:e2e:cleanup
```


Home uses right-aligned chevrons for its disclosure sections. During browser
approval, sign-in, and opening chat, a full-window blurred overlay displays a
pulse and activity-specific status. Approval codes, paste input, and Cancel stay
above the blur. The pulse respects reduced-motion preferences. The loading
presentation continues in the chat webview until the authenticated chat UI is
ready. Renaming the app to Discourse Chat App preserves its bundle identifier
and existing saved sessions.
