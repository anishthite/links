# Links Side Companion

Chrome Side Panel extension for saving the current tab to Links.

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this `extension/` folder.
4. Click the extension button; Chrome opens the side panel.

## Use it

- Default app: `https://links.anishthite.workers.dev`
- Local app: set **App URL** to `http://127.0.0.1:8788`
- Custom app: add that origin to `host_permissions` in `manifest.json`, then reload the extension.

The panel posts to `POST /api/links` with the active tab URL plus optional note and comma-separated tags.
