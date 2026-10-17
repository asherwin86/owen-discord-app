# LanChat

A simple Discord-style chat that runs from a Windows app and is used from any browser on your network.

- **Name-only sign in** - type a name to join. A new name creates an account; an existing name signs you back in. There are no passwords, so anyone on your network can sign in as any name. The network (Wi-Fi password) is the only protection.
- **Friends** - send/accept requests, see who is online, direct message.
- **Groups** - group chats made from your friends.
- **Servers** - create a server with channels, share the invite code, others join with it.
- **Voice channels** - every new server gets a "Lounge" voice channel; owners can add more. Click one to join, with mute, leave and a speaking highlight. Audio goes peer-to-peer (WebRTC) between browsers, up to 8 people per channel.
- Realtime messages, unread badges, works on phones (mobile layout).

- **QR code** - in a voice channel press **QR** to show a code. Scan it with a phone on the same Wi-Fi: it opens the secure link, you enter a name, and you land in that voice channel (tap **Join voice**). Voice channels also have a normal text chat. The code carries the server's invite code, so anyone who scans it can join the server.

## Voice needs HTTPS

Browsers only allow microphone access on secure pages: `https://...` or `http://localhost`. So the host also serves HTTPS (port 3443) with a self-signed certificate. On other devices use the "secure link" shown in the host window, e.g. `https://192.168.0.114:3443`. Your browser warns about the certificate once: choose **Advanced**, then **Continue**. Allow the microphone when asked. Voice drops if the browser tab is backgrounded or the phone screen locks.

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

1. Bump `version` in `package.json` (e.g. `1.1.1`).
2. Create a GitHub token with `repo` scope and set it: `$env:GH_TOKEN = "<token>"`
3. Run `npm run release` - this builds and publishes a GitHub release with the installer and `latest.yml`.
   (No token? Run `npm run dist`, then on GitHub create a release tagged `v<version>` and upload `dist/LanChat-Host-Setup-<version>.exe`, its `.blockmap`, and `dist/latest.yml`.)
4. Running hosts pick it up automatically (within 4 hours, or via "Check now").

Auto-update only works in the installed app (not `npm start`), and the repo must be public (or the app given a token) for the updater to read releases. Update activity is logged to `%APPDATA%\LanChat Host\updater.log`.

To test an update without GitHub, serve the `dist` folder over http and start the app with `LANCHAT_UPDATE_URL=http://localhost:8099` set.

## Where data lives

Installed app: `%APPDATA%\LanChat Host\data\data.json`. Back that file up to keep accounts and history.
