// Prevents a console window from popping up alongside the app on Windows release builds.
// No-op on macOS/Linux. Kept for forward compatibility if we ever add other targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
