// Prevents a console window from popping up alongside the app on Windows release builds.
// No-op on macOS/iOS/Linux. Kept for forward compatibility.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    board_mobile_lib::run()
}
