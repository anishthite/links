// Shared Tauri 2 mobile entry point. Both iOS (via cargo-mobile2 scaffold) and
// the desktop fallback in main.rs call this `run()` function — single source of
// truth for the builder config.
//
// Mirrors `desktop/src-tauri/src/main.rs` intentionally: a thin webview around
// https://board.thite.site. No commands, no plugins, no IPC surface — the
// remote page has zero `window.__TAURI__` access (defence-in-depth).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
