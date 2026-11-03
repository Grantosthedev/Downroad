# Downroad

A macOS desktop app for downloading videos and images from YouTube, Instagram, and TikTok. Set in/out points, choose quality, and download clips without fetching the full video.

Built with Electron, yt-dlp, and ffmpeg.

## Features

- **Multi-platform** — YouTube, Instagram (reels, carousels, images), and TikTok
- **Partial downloads** — only downloads the clip you specify, not the entire video
- **Quality options** — Best/4K, HD 1080p, or Audio Only
- **Instagram carousels** — browse and select individual items to download
- **Auto-updates** — app updates itself over wifi, no manual DMG needed
- **QuickTime & Premiere Pro compatible** — outputs .mp4 (H.264/VP9) and .m4a (AAC)
- **Clipboard auto-detect** — copies URLs from your clipboard automatically
- **Drag & drop** — drop a link onto the app window
- **macOS notifications** — get notified when downloads complete
- **No dependencies** — everything is bundled in the app

## Installation (for coworkers)

1. Download the `.dmg` file
2. Open it and drag **Downroad** to your Applications folder
3. **Important — first launch on macOS:**
   - Right-click the app and select **Open**
   - Click **Open** in the dialog that appears
   - This is a one-time step (macOS blocks unsigned apps by default)

## Development Setup

```bash
# Clone the repo
git clone https://github.com/Grantosthedev/Downroad.git
cd Downroad

# Install dependencies (this also downloads the yt-dlp binary)
npm install

# Start the app in development mode
npm start
```

## Building

```bash
# Create a .dmg for distribution (local only)
npm run make
```

The `.dmg` will be in the `out/make` folder.

## Releasing (Auto-Update)

Starting with v1.3.0, the app auto-updates itself via [update.electronjs.org](https://github.com/electron/update.electronjs.org) backed by GitHub Releases. Users get an in-app prompt to restart when an update is ready.

```bash
# Bump version in package.json, then:
npm run publish
# Go to GitHub Releases > publish the draft
```

See [RELEASING.md](RELEASING.md) for the full step-by-step guide, prerequisites, CI setup, and troubleshooting.

## Updating yt-dlp

If downloads start failing, YouTube may have changed its API. Open Settings and hit **Check for updates** to refresh the yt-dlp engine.

When YouTube rejects a normal playback request, Downroad starts its local PO-token provider and retries automatically with yt-dlp's recommended mobile web client. No browser cookies or account connection are required.

## Instagram Remote Config

Instagram rotates their API tokens every 2-4 weeks. To fix Instagram downloads without a new app release, edit `config/instagram-config.json` in this repo and push to `main`. All installed apps fetch the updated config within 24 hours.

## Tech Stack

- **Electron** + **Electron Forge** — desktop app framework and build tools
- **yt-dlp** — video/media downloading engine ([github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp))
- **ffmpeg** — media processing (via ffmpeg-static)
- **Vanilla HTML/CSS/JS** — no framework, just clean code
- **Squirrel.Mac** + **update.electronjs.org** — native auto-updates via GitHub Releases

## License

MIT
