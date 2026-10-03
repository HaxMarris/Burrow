# Burrow

A small, self-hosted Discord-style chat for you and your friends. You run the
server on your own machine or a cheap VPS; your friends install the desktop app
(or just open the server's address in a browser) and log in.

![Burrow in the light theme](screenshots/desktop-light.png)

**What works today**

- Accounts with username and password, protected by an optional registration code so strangers can't sign up
- Burrows (shared spaces) you create, with an invite code to share, and rooms the host can add
- Voice rooms (via [LiveKit](https://livekit.io), self-hosted alongside Burrow) with mute and who's-talking rings
- Image and file sharing: attach, paste or drag in up to 10 files per message, with inline image and video previews
- Emoji reactions and replies (a reply to you counts as a mention)
- Direct messages with anyone you share a burrow with
- Profile pictures and password changes (changing your password logs out your other devices)
- Real-time messaging over WebSockets, with typing indicators and online/offline presence
- Full message history with infinite scroll back, edit and delete your own messages (↑ edits your last one)
- Light formatting: `**bold**`, `*italic*`, `` `code` ``, code blocks, clickable links, `@mentions` (highlighted, and they trigger a desktop notification)
- Unread markers on channels and servers
- Desktop app for Windows, macOS and Linux (Electron), plus the same UI in any browser
- Scandinavian-forest look with light and dark themes

**Not yet:** video and screen sharing, DMs, roles and permissions. See [Roadmap](#roadmap).

## Layout

```
chat-app/
├── server/     Node.js + TypeScript server (HTTP API, WebSockets, SQLite)
├── client/     The chat UI (plain HTML/CSS/JS), served by the server and bundled into the desktop app
├── desktop/    Electron wrapper that packages the client as an installable app
├── Dockerfile, docker-compose.yml
└── .github/workflows/desktop-release.yml   Builds installers on GitHub when you publish a release
```

The server has one runtime dependency (`ws`). It uses Node's built-in SQLite
and runs TypeScript directly, so there is no build step. It needs Node 22.18 or newer.

## 1. Run the server

### With Docker (recommended)

Copy the settings file and set a registration code only your friends will know:

```sh
cp .env.example .env
nano .env        # change REGISTRATION_CODE (and the voice secret, or remove the voice lines)
docker compose up -d --build
```

The server is now on port 3000, and its database lives in the `burrow-data` volume. All your
settings stay in `.env`, so updating is always:

```sh
git pull && docker compose up -d --build
```

### Without Docker

```sh
cd server
npm install
REGISTRATION_CODE=pick-something npm start
```

Data goes to `server/data/chat.db`.

### Settings

| Variable            | Default                | What it does                                                        |
| ------------------- | ---------------------- | ------------------------------------------------------------------- |
| `REGISTRATION_CODE` | unset (open signup)    | Code people must enter to create an account. Strongly recommended. |
| `PORT`              | `3000`                 | Port to listen on.                                                  |
| `DB_FILE`           | `server/data/chat.db`  | SQLite database location (`/data/chat.db` in Docker).               |
| `BACKUP_DIR`        | `backups/` next to the database | Where the daily database copies go (`/data/backups` in Docker). |
| `BACKUP_KEEP`       | `7`                    | How many daily copies to keep. `0` turns backups off.               |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | unset (voice off) | Shared with LiveKit; turns on voice rooms.             |
| `UPLOAD_DIR`        | `uploads/` next to the database | Where shared files are stored (`/data/uploads` in Docker).  |
| `MAX_UPLOAD_MB`     | `25`                   | Largest file someone can share.                                     |
| `LIVEKIT_URL`       | same address as Burrow | Where apps reach LiveKit, if not routed through Burrow's address.   |

### Letting friends reach it

Your friends need to reach the server over the internet. The usual options:

1. **A VPS** (any $5/month box): run Docker Compose there and point a domain at it.
2. **Your home PC**: forward TCP port 3000 on your router to that machine and give friends your public IP.
3. **Tailscale**: everyone installs Tailscale and joins your tailnet; nothing is exposed publicly. Easiest and safest for a small group.

For anything public, put HTTPS in front so passwords aren't sent in the clear.
[Caddy](https://caddyserver.com) does it in two lines and handles WebSockets automatically:

```
chat.example.com {
    @livekit path /rtc /rtc/*
    reverse_proxy @livekit localhost:7880
    reverse_proxy localhost:3000
}
```

The `@livekit` lines are only needed for voice rooms (below); they're harmless without them.

### Voice rooms

Voice runs on [LiveKit](https://livekit.io), a media server that Docker Compose starts next to Burrow.
Voice only is light enough for a Raspberry Pi 4 or 5. The limit is usually your home upload
speed: LiveKit sends each speaker to every listener at about 40 kbps, so a room of 10 needs up to
about 4 Mbps of upload.

1. Copy `.env.example` to `.env` in the same folder as `docker-compose.yml`, and replace the secret
   with the output of `openssl rand -base64 32`.
2. `docker compose up -d --build`. This now starts `livekit` too.
3. Add the two `@livekit` lines above to your Caddyfile and restart Caddy.
4. On your router, forward **TCP 7881** and **UDP 7882** to the server, alongside 80 and 443.

The host then adds a room with **+** next to *Rooms* and picks *Voice room*. Click a voice room to
join; the bar above your name has mute and leave.

### Backups

Burrow copies its database once a day and keeps the last 7 copies. They sit on the same disk as
the server, so now and then copy them somewhere else. With Docker:

```sh
docker compose cp burrow:/data/backups ./backups
```

To restore one (swap in the date you want):

```sh
docker compose stop burrow
docker compose run --rm --entrypoint sh burrow -c "cp /data/backups/burrow-2026-10-05.db /data/chat.db && rm -f /data/chat.db-wal /data/chat.db-shm"
docker compose up -d
```

## 2. Get your friends the app

**Browser:** they open your server address (e.g. `https://chat.example.com`), click *Register*, and enter the registration code.

**Desktop app:** the first time it opens it asks for the server address, then works the same way.

To build installers, let GitHub do it: on the repo page go to **Releases → Draft a new release**,
type a new tag such as `v0.1.0`, and click **Publish release**. The `Desktop release` workflow then
builds a Windows `.exe`, macOS `.dmg` and Linux `.AppImage` and attaches them to that release,
usually within about ten minutes. Send your friends the release link.

**Updates:** the desktop app checks for a newer release when it starts and every six hours.
On Windows and Linux it downloads the update in the background and asks to restart; if they pick
*Later*, it installs the next time they quit. On macOS it shows a *Download* button that opens the
release page, because macOS only lets signed apps update themselves. Release tags must look like
`v1.2.3`; the tag becomes the app's version number.

You can also run the workflow by hand from the **Actions** tab to get test builds without publishing anything.

To build locally instead (each OS builds its own installer best):

```sh
cd desktop
npm install
npm start        # run it without packaging
npm run dist     # build an installer for the current OS into desktop/dist/
```

The installers are unsigned, so Windows SmartScreen will say "Windows protected your PC"
(click *More info → Run anyway*) and macOS needs right-click → *Open* the first time.
Code-signing certificates fix that but cost money.

## 3. Using it

Burrow has its own names for things: a **burrow** is a shared space for one group of friends (what Discord calls a server), and each burrow has **rooms** (channels).

- Click **+** under *Your burrows* to dig a new burrow, or join one with an invite code.
- The gear next to the burrow's name shows its invite code. The host (whoever created it) can delete the burrow there; everyone else can leave.
- The host adds rooms with the **+** next to *Rooms*.
- The speech-bubble tile above your burrows holds your direct messages. Start one with its **+**, or click someone in a burrow's member list.
- Click your name in the bottom corner to set a profile picture or change your password.
- The moon button in your profile card switches between the light "birch" theme and the dark "pine night" theme. By default it follows your system setting.

## Development

```sh
cd server
npm install
npm run dev      # restarts on changes; open http://localhost:3000
npm test         # end-to-end API and WebSocket tests
```

Client changes need only a browser refresh. The API is plain JSON over HTTP
with a bearer token, and live events come over `/ws?token=…`; see `server/src/app.ts`.

## Roadmap

Done: auto-update for the desktop app (fully automatic on macOS needs code signing), voice rooms, image and file sharing, reactions and replies, profile pictures and password changes, and direct messages.

Rough order of what would make it feel more like Discord:

1. Roles and permissions (moderators, private channels)
2. Video and screen sharing in voice rooms

## Alternatives

If you would rather run something mature than your own code, these are self-hostable
and Discord-like: [Revolt / Stoat](https://github.com/revoltchat) (closest look and feel),
[Matrix](https://matrix.org) with the Element client (federated, very full-featured, heavier to run),
and [Mumble](https://www.mumble.info) for voice only.
