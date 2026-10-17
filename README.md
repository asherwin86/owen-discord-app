# LanChat

A simple Discord-style chat that runs from a Windows app and is used from any browser on your network.

- **Name-only sign in** - type a name to join. A new name creates an account; an existing name signs you back in. There are no passwords, so anyone on your network can sign in as any name. The network (Wi-Fi password) is the only protection.
- **Friends** - send/accept requests, see who is online, direct message.
- **Groups** - group chats made from your friends.
- **Servers** - create a server with channels, share the invite code, others join with it.
- Realtime messages, unread badges, works on phones (mobile layout).

## Run it (development)

```bash
npm install
npm start          # Windows host app (server + tray + status window)
npm run server     # or just the server, no Electron (data in ./data)
npm test           # end-to-end smoke test
```

The host window shows the addresses to open from other devices, e.g. `http://192.168.1.20:3000`.
Closing the window keeps the server running in the system tray; "Quit" in the tray stops it.

**Windows Firewall:** the first launch asks to allow network access. Tick **Private networks**, otherwise other devices can't connect.

## Build the installer

```bash
npm run dist       # builds dist/LanChat Host Setup x.y.z.exe
```

## Auto-update

The app uses `electron-updater` with GitHub Releases from `asherwin86/owen-discord-app` (set in `package.json` -> `build.publish`).
It checks on startup and every 4 hours, downloads in the background, and installs when you click **Restart & update** (or on next quit).

To ship an update:

1. Bump `version` in `package.json` (e.g. `1.0.1`).
2. Create a GitHub token with `repo` scope and set it: `$env:GH_TOKEN = "<token>"`
3. Run `npm run release` - this builds and uploads the installer as a draft GitHub release.
4. Publish that draft release on GitHub. Running hosts pick it up automatically.

Auto-update only works in the installed app (not `npm start`), and the repo must be public (or the app given a token) for the updater to read releases.

## Where data lives

Installed app: `%APPDATA%\LanChat Host\data\data.json`. Back that file up to keep accounts and history.
