# Board — iOS shell

Thin [Tauri 2](https://v2.tauri.app/) wrapper around <https://board.thite.site>,
mirroring [`../desktop/`](../desktop/) for iPhone.

The webview points at the live Cloudflare Pages deploy, so **shipping the web
app ships the iOS app**. No bundled JS, no auto-updater — just a native iOS
binary that loads the production URL on launch.

> Decisions and rationale: [`../implementation-notes/2026-05-28-tauri-ios-mobile-wrapper.html`](../implementation-notes/2026-05-28-tauri-ios-mobile-wrapper.html)

---

## One-time setup

Same Rust + Tauri CLI as desktop. Plus iOS Rust targets and Xcode:

```bash
# Xcode (full IDE, not just CLT) — required for ANY iOS build
# Install from the Mac App Store, then accept license once:
sudo xcodebuild -license accept

# Apple ID logged into Xcode (Xcode → Settings → Accounts → "+") — required
# for code-signing. A free personal Apple ID is enough for sideloading.

# Rust toolchain (skip if you already built the desktop shell)
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh

# iOS Rust targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# Tauri CLI (skip if already installed for desktop)
cargo install tauri-cli --version "^2.0" --locked

# CocoaPods — Tauri's iOS scaffold uses it for Swift/Obj-C integration
sudo gem install cocoapods
```

## First run — scaffold the Xcode project

```bash
cd mobile/src-tauri

# Generates gen/apple/ (Xcode project, project.yml, Assets.xcassets, etc.)
cargo tauri ios init

# Regenerates AppIcon.appiconset from the shared icon source
cargo tauri icon ../icon-source.png -- --ios-color '#ffffff'
```

After `tauri ios init`, edit `gen/apple/<name>.xcodeproj` in Xcode once to:

1. Select the project root → **Signing & Capabilities** → set **Team** to your
   personal Apple ID. (You can also set `APPLE_DEVELOPMENT_TEAM=<10-char-team-id>`
   in your shell to skip this step on future re-inits.)

`gen/apple/` is gitignored — it's regenerated from `Cargo.toml` + `tauri.conf.json`
on demand.

## Run on a physical iPhone (current happy path)

With Xcode 16.4 + iPhone on iOS 26+, the iOS Developer Disk Image needed for
`cargo tauri ios dev` doesn't exist. Workaround: build a release IPA via the
Tauri CLI, push it over USB via [libimobiledevice](https://libimobiledevice.org/)
which doesn't need the DDI:

```bash
# one-time setup
brew install libimobiledevice ideviceinstaller

# every build + install (~30s warm cache)
cd mobile/src-tauri
cargo tauri ios build --export-method debugging
ideviceinstaller install gen/apple/build/arm64/Board.ipa
```

App appears on home screen / App Library. Mahesh Thite paid team =
1-year provisioning, no weekly re-sign.

### One-time per iPhone: register UDID with the team

First install on a brand-new iPhone: your UDID needs to be in the team's
provisioning profile. `cargo tauri ios build` targets a generic destination,
so Xcode never sees the specific phone and can't auto-register it.
One-time fix:

1. Plug in iPhone, unlock it.
2. iPhone: **Settings → Privacy & Security → Developer Mode → ON**, reboot.
3. `open gen/apple/board-mobile.xcodeproj` (from `mobile/src-tauri/`).
4. In Xcode's top toolbar, click the destination dropdown → pick your iPhone
   under "Connected".
5. **Cmd+B** (Build — NOT Run). The build will fail late with
   `cargo: command not found` (Gotcha #1 below). Doesn't matter — Xcode
   registers the device with Apple's portal and writes a fresh provisioning
   profile to `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`
   BEFORE the script phase fails.
6. Close Xcode. Run the normal `cargo tauri ios build` + `ideviceinstaller`
   from terminal. The fresh profile is picked up automatically.

First install per Apple ID per device, iOS will ask you to trust the
developer: **Settings → General → VPN & Device Management → Mahesh Thite
→ Trust**.

### Run in the iOS Simulator (no device needed)

```bash
xcrun simctl boot 'iPhone 16 Pro'           # boot the sim first (must be running)
open -a Simulator
cd mobile/src-tauri
cargo tauri ios dev 'iPhone 16 Pro'
```

Good for quick layout/CSS sanity checks. Doesn't exercise WKWebView cookie
persistence the same way a real device does, so test auth flows on the phone.

### TestFlight (cable-free install to other devices)

```bash
cd mobile/src-tauri
cargo tauri ios build --export-method app-store-connect
# upload IPA via Transporter.app or `xcrun altool --upload-app`
```

Processing takes 15-30 min in App Store Connect. Then install via TestFlight
app on iPhone. Only needed if you want to install on a phone that isn't
cabled to this Mac.

## Cloudflare Access login

First launch shows the CF Access login page inside the app. WKWebView's default
[`WKWebsiteDataStore`](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)
persists the `CF_Authorization` cookie in the app's container
(`<App>/Library/WebKit/`), so you log in **once** and it survives restarts +
upgrades — same behavior as the desktop shell.

To force-logout: delete the app from the phone (cookies live inside the app
container, not in Safari).

## Updating the icon

The iOS iconset is generated from `icon-source.png` (symlink to the shared
desktop source). To regenerate after editing the SVG:

```bash
cd mobile/src-tauri
cargo tauri icon ../icon-source.png -- --ios-color '#ffffff'
```

This writes `gen/apple/Assets.xcassets/AppIcon.appiconset/` with every required
iOS size (20×20 through 1024×1024, all scale factors).

The `--ios-color` is the background color composited under transparent pixels
(iOS app icons forbid alpha). Match the brand color or stick with white.

---

## Known gotchas

These come from current (2025-2026) Tauri 2 mobile experience — surfaces of
the toolchain that bite if you don't know about them. Documented up front so
you don't blame yourself.

| # | Gotcha | Mitigation |
|---|---|---|
| 1 | **Xcode build phase doesn't see your shell PATH.** Node version managers (nvm, fnm, asdf), Homebrew on Apple Silicon, and `~/.cargo/bin` may all be missing. Symptom: "command not found" / "rustc not in PATH" inside Xcode. | Make sure `rustc` and `cargo` are linkable from `/usr/local/bin`, or set absolute paths inside `gen/apple/project.yml` build-phase scripts. Re-run `cargo tauri ios init` after fixing PATH so it picks up the right binaries. |
| 2 | **Mahesh team Apple ID credentials in Xcode silently expire.** Build appears to succeed but produces ad-hoc-signed `.app` that can't install on a device. Tell by running `codesign -dvv path/to/Board.app` — if you see `Signature=adhoc, TeamIdentifier=not set`, this is the problem. | Xcode → Settings → Accounts → click any account with a warning badge → re-enter password + 2FA. Watch out: Xcode iterates ALL configured accounts on every signing op, so a broken account fatals the whole build even if it's not the selected team. |
| 3 | **iOS Developer Disk Image missing for iOS 26+** in Xcode 16.4. `cargo tauri ios dev` fails with "Developer Disk Image is not mounted." | Use `cargo tauri ios build --export-method debugging` + `ideviceinstaller install` instead — bypasses DDI. Upgrade Xcode to 26.x if you want `cargo tauri ios dev` to work directly. |
| 4 | **iPhone UDID not in provisioning profile.** `ideviceinstaller` errors with `0xe8008015 "A valid provisioning profile for this executable was not found."` | One-time Xcode UI build to trigger device registration. See "One-time per iPhone" section above. |
| 5 | **Remote URL fails on device but works in simulator** on Tauri 2.x patches before [PR #13782](https://github.com/tauri-apps/tauri/pull/13782) (merged 2025-07-09). Symptom: white screen on the iPhone, fine in simulator. | This project pins `tauri = "2"` which resolves to ≥ 2.11.x; the fix is in. If you ever downgrade, pin ≥ 2.11.0 explicitly. |
| 6 | **First time you open the app on the physical device**, iOS shows "Untrusted Developer." | Settings → General → VPN & Device Management → Mahesh Thite → Trust. One-time per Apple ID per device. |
| 7 | **CocoaPods `bundle exec pod install` hang** during `cargo tauri ios init`. | Make sure `sudo gem install cocoapods` finished cleanly. Run `pod repo update` once to seed the spec mirror. |

---

## What ships, what doesn't

| Layer | Source | Updates when |
|---|---|---|
| Web app HTML/CSS/JS | `https://board.thite.site` | Every `npm run deploy` on the web side. **No iOS rebuild needed.** |
| iOS shell binary (Rust + Tauri) | `mobile/src-tauri/` | When you rebuild the IPA. Rare — only when you change shell config (window size, identifier, plist keys) or upgrade Tauri. |
| Icon | `mobile/icon-source.png` (symlink to `desktop/icon-source.png`) | Edit the SVG, regenerate PNGs, re-run `cargo tauri icon`. |

This is the entire point of the shell: the iPhone app is always in lockstep
with the web deploy. Treat the IPA like firmware — build once, almost never
touch.
