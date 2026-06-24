# Board — desktop shell

Thin [Tauri 2](https://v2.tauri.app/) wrapper around <https://board.thite.site>.

The webview points at the live Cloudflare Pages deploy, so **shipping the web app ships the desktop app**. No bundled JS, no auto-updater to maintain — just a native `.app` window that loads the production URL on launch.

> Decisions and rationale: [`../implementation-notes/2026-05-28-tauri-desktop-wrapper.html`](../implementation-notes/2026-05-28-tauri-desktop-wrapper.html)

---

## One-time setup

```bash
# Xcode Command Line Tools (needed for any Rust macOS build)
xcode-select --install

# Rust toolchain (if you don't have it)
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh

# Tauri CLI — cargo-only, no npm involvement
cargo install tauri-cli --version "^2.0" --locked
```

That's it. No `npm install`, no `package.json` in this folder.

## Run in dev

```bash
cd desktop/src-tauri
cargo tauri dev
```

First build pulls ~300 crates and takes a few minutes. Subsequent rebuilds are seconds.

## Build the `.app` and `.dmg`

```bash
cd desktop/src-tauri
cargo tauri build --bundles app,dmg
```

Outputs:

- `desktop/src-tauri/target/release/bundle/macos/Board.app`
- `desktop/src-tauri/target/release/bundle/dmg/Board_0.1.0_aarch64.dmg`

Drag `Board.app` into `/Applications`. First launch: **right-click → Open** (Gatekeeper warning — expected, the bundle is ad-hoc signed, not notarized).

### Universal binary (Apple Silicon + Intel)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri build --target universal-apple-darwin --bundles app,dmg
```

## Cloudflare Access login

First launch shows the CF Access login page inside the app window. After login, the `CF_Authorization` cookie is stored in `~/Library/WebKit/site.thite.board/` (WKWebView's default persistent data store) and survives restarts — you log in once.

To force-logout, quit the app and delete that directory.

## Updating the icon

The icon is generated from [`icon-source.svg`](./icon-source.svg) (a square version of the web favicon). To regenerate after editing the SVG:

```bash
cd desktop
rsvg-convert -w 1024 -h 1024 icon-source.svg -o icon-source.png

sips -z 32   32   icon-source.png --out src-tauri/icons/32x32.png
sips -z 128  128  icon-source.png --out src-tauri/icons/128x128.png
sips -z 256  256  icon-source.png --out 'src-tauri/icons/128x128@2x.png'

mkdir -p icon.iconset
sips -z 16   16   icon-source.png --out icon.iconset/icon_16x16.png
sips -z 32   32   icon-source.png --out icon.iconset/icon_16x16@2x.png
sips -z 32   32   icon-source.png --out icon.iconset/icon_32x32.png
sips -z 64   64   icon-source.png --out icon.iconset/icon_32x32@2x.png
sips -z 128  128  icon-source.png --out icon.iconset/icon_128x128.png
sips -z 256  256  icon-source.png --out icon.iconset/icon_128x128@2x.png
sips -z 256  256  icon-source.png --out icon.iconset/icon_256x256.png
sips -z 512  512  icon-source.png --out icon.iconset/icon_256x256@2x.png
sips -z 512  512  icon-source.png --out icon.iconset/icon_512x512.png
cp icon-source.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o src-tauri/icons/icon.icns
rm -rf icon.iconset
```

(`cargo tauri icon icon-source.png` does the same thing, but also drops Windows/Store assets you don't need on macOS.)

## Layout

```
desktop/
├── README.md             ← you are here
├── icon-source.svg       ← editable source artwork
├── icon-source.png       ← 1024×1024 render
└── src-tauri/
    ├── Cargo.toml        ← Rust deps (tauri 2 + tauri-build 2)
    ├── build.rs          ← runs tauri_build::build() at compile time
    ├── tauri.conf.json   ← window, bundle, signing config
    ├── src/main.rs       ← 8-line tauri::Builder entrypoint
    └── icons/            ← generated, committed
```

No `capabilities/` directory by design — the remote webview has no `window.__TAURI__` IPC surface, which is both simpler and tighter.
