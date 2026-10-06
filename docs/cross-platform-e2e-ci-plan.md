# Windows and Linux E2E CI plan

Research date: 2026-10-06. Status: proposed; no Windows or Linux app runs have
been performed for this project yet.

## Goal and feasibility

Run the actual Discourse Chat App on GitHub-hosted Windows and Linux runners,
testing browser authorization, native session establishment, chat messaging,
saved sessions, and logout. Browser-only UI tests complement these checks but
do not verify the native cookie integration.

TinyJS's upstream release workflow already includes a real Windows GUI smoke
test and a Linux GUI smoke test under Xvfb. This supports starting with hosted
runners; self-hosted desktops are a fallback if app-specific limitations emerge.
Windows and Linux support in TinyJS is currently labelled beta.

Sources:

- [TinyJS platform documentation](https://github.com/tarwin/tinyjsapp#install)
- [TinyJS release workflow](https://github.com/tarwin/tinyjsapp/blob/main/.github/workflows/release.yml)
- [Playwright WebView2 automation and profile isolation](https://playwright.dev/docs/webview2)
- [Playwright CI and Xvfb guidance](https://playwright.dev/docs/ci#running-headed)

These upstream documents describe feasibility, not a successful run of our app.

## Runner and automation strategy

| Platform | Initial target | Native automation |
| --- | --- | --- |
| Windows | GitHub-hosted `windows-2025`, x64 | Launch TinyJS/WebView2 with an isolated profile and reuse our test-only bridge. Optionally attach Playwright over CDP for webview interactions and screenshots. |
| Linux | GitHub-hosted `ubuntu-24.04`, x64 | Install WebKitGTK and native build dependencies; launch the actual app under Xvfb with a D-Bus session and reuse our test-only bridge. |

Pin the TinyJS version and use explicit runner labels. Verify WebView2 availability
and install it when absent. Record runner and webview versions in diagnostics.
Start with one worker per native job.

On Windows, Playwright supports attaching to WebView2 through
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` and `connectOverCDP()`. Use a unique
`WEBVIEW2_USER_DATA_FOLDER` for each run. Any debugging endpoint must be local
and enabled only for tests.

On Linux, use the system WebKitGTK webview. Playwright's bundled WebKit browser
is not a substitute for testing the app's native session implementation. The
existing command/report bridge avoids requiring a separate WebDriver integration.
An initial launch command can follow this shape once setup is portable:

```sh
dbus-run-session -- xvfb-run -a npm run test:e2e
```

## Current blockers and required changes

### 1. Port the production native integration

`native/chat-session.inc` uses macOS APIs for session checking, OTP login,
cookie transfer, logout, website-data clearing, and Home navigation. Implement
equivalent Windows and Linux operations behind the existing backend interface.
Preserve the origin restrictions and the rule that site login pages never appear.

`scripts/setup-runtime.sh` and `scripts/build-runtime.sh` currently target macOS.
Add platform-specific setup/build paths and validate a minimal native launch
before attempting the live authentication test.

### 2. Make the E2E harness portable

The reusable pieces are in `scripts/e2e/run.mjs` and `scripts/e2e/app.js`: stage
tracking, browser approval, webview commands, messaging assertions, and server
verification.

Required adaptations:

- Replace the macOS-only launcher build in `scripts/e2e/build.sh` with platform
  implementations that use isolated webview data stores or temporary profiles.
- Handle Windows drive-letter paths, executable suffixes, process-tree cleanup,
  and the distinction between POSIX permissions and Windows access controls.
- Replace `sips` PDF-to-PNG conversion with a portable converter or native
  webview screenshots. PDF captures should remain labelled as such.
- Keep test commands and reporting out of production builds, retaining caller
  origin checks in the test bridge.
- Add a separate restart scenario with a temporary persistent profile and
  persistent test preferences. The current ephemeral profile and in-memory
  store cannot prove session restoration across process restarts.

### 3. Isolate Discourse fixtures

The existing fixture uses one `chat_wrapper_e2e` user. Cleanup revokes all of
that user's sessions and API keys, so concurrent CI jobs would invalidate one
another. The local `.e2e/run.lock` does not coordinate separate runners.

Initially serialize live tests across workflows and platforms. Then introduce
per-run users and isolated fixtures, passing the resulting username and IDs
through the harness instead of relying on hard-coded values. Cleanup must affect
only the current run's fixtures.

Retain the controlled do1.musaraj.com test site for the initial implementation.
CI needs an explicit fixture-provisioning interface: the current `do-hermes`
SSH alias and developer key are not available on hosted runners. Prefer a
restricted server-side provisioning command or service over general server
administration access. Store its credential in GitHub secrets.

Run cleanup after failures as well as success. Add server-side expiry or a
scheduled janitor for fixtures left by cancelled or terminated jobs.

### 4. Add CI workflows and diagnostics

Use two layers:

| Trigger | Coverage | Server credentials |
| --- | --- | --- |
| Every PR | Unit tests, browser UI checks, native startup/Home smoke tests | None |
| Trusted pushes and manual runs | Full browser approval, native session, chat, and logout flow | Restricted fixture credential |

Do not execute untrusted PR code with fixture credentials. Keep tokens and
generated authentication data out of logs. Upload an explicit allowlist of
screenshots, sanitized logs, and stage results rather than the entire `.e2e`
directory or `.env.e2e.local`. Redact authorization codes from published
screenshots and set bounded artifact retention.

## Test coverage

The initial live suite should assert:

1. Empty Home state and first-site authentication controls render.
2. Browser approval completes and the temporary API key is exchanged and revoked.
3. The native webview establishes its own authenticated session without showing
   the site's login screen.
4. The test user opens the private channel and sends exactly one uniquely marked
   message, verified on the server.
5. Home shows the active saved session and reopens the site successfully.
6. Logout retains the site and offers reauthentication; reauthentication works.
7. Cancellation and failed authentication return to an actionable Home state.
8. A later restart scenario restores the saved session from an isolated
   persistent test profile.

Capture each significant screen and retain useful failure diagnostics. Use
timeouts around app launch, browser approval, navigation, and cleanup.

## Coverage limits

- The current harness intercepts browser opening and seeds an authenticated
  browser cookie. It verifies approval and the native session exchange, not OS
  default-browser registration or logging into Discourse from scratch.
- DOM commands exercise the real webview but do not prove native keyboard,
  mouse, window-control, or menu interaction. Add focused desktop checks as needed.
- Notification appearance and click-through require separate desktop integration
  checks. The current E2E driver disables notifications.
- Xvfb covers Linux X11 execution, not Wayland. Windows Server runners also do
  not cover every Windows desktop configuration. Keep a release smoke check on
  supported end-user desktops for these differences.

## Implementation order and completion criteria

1. Port the native session interface and build scripts; demonstrate a minimal
   launch on both hosted runner types.
2. Make the harness portable and add credential-free native Home smoke tests.
3. Provision restricted CI fixture access and serialize live runs.
4. Enable the live authentication/message/logout suite, screenshots, and cleanup.
5. Add per-run fixtures, parallel platform jobs, and restart coverage.
6. Add targeted desktop notification and platform-integration checks.

The first CI milestone is complete when both platforms launch the real app,
complete browser approval and native login, send and verify a message, reopen a
saved site, log out, publish sanitized diagnostics, and clean up successfully.
Failures must fail the job rather than being reported as skipped platform support.
