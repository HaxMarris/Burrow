# Burrow

A small, self-hosted Discord-style chat for you and your friends. You run the
server on your own machine or a cheap VPS; your friends install the desktop app
(or just open the server's address in a browser) and log in.

![Burrow in the light theme](screenshots/desktop-light.png)

**What works today**

- Accounts with username and password, protected by an optional registration code so strangers can't sign up
- Burrows (shared spaces) you create, with an invite code to share, and rooms the host can add
- Real-time messaging over WebSockets, with typing indicators and online/offline presence
- Full message history with infinite scroll back, edit and delete your own messages (↑ edits your last one)
- Light formatting: `**bold**`, `*italic*`, `` `code` ``, code blocks, clickable links, `@mentions` (highlighted, and they trigger a desktop notification)
- Unread markers on channels and servers
- Desktop app for Windows, macOS and Linux (Electron), plus the same UI in any browser
- Scandinavian-forest look with light and dark themes

**Not yet:** voice/video, image and file uploads, DMs, roles and permissions, reactions. See [Roadmap](#roadmap).

## Layout

```
chat-app/
├── server/     Node.js + TypeScript server (HTTP API, WebSockets, SQLite)
├── client/     The chat UI (plain HTML/CSS/JS), served by the server and bundled into the desktop app
├── desktop/    Electron wrapper that packages the client as an installable app
├── Dockerfile, docker-compose.yml
└── .github/workflows/desktop-release.yml   Builds installers on GitHub when you push a tag
```

The server has one runtime dependency (`ws`). It uses Node's built-in SQLite
and runs TypeScript directly, so there is no build step. It needs Node 22.18 or newer.

## 1. Run the server

### With Docker (recommended)

Edit `docker-compose.yml` and change `REGISTRATION_CODE` to something only your
friends will know, then:

```sh
docker compose up -d --build
```

The server is now on port 3000, and its database lives in the `burrow-data` volume.

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

### Letting friends reach it

Your friends need to reach the server over the internet. The usual options:

1. **A VPS** (any $5/month box): run Docker Compose there and point a domain at it.
2. **Your home PC**: forward TCP port 3000 on your router to that machine and give friends your public IP.
3. **Tailscale**: everyone installs Tailscale and joins your tailnet; nothing is exposed publicly. Easiest and safest for a small group.

For anything public, put HTTPS in front so passwords aren't sent in the clear.
[Caddy](https://caddyserver.com) does it in two lines and handles WebSockets automatically:

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

## 2. Get your friends the app

**Browser:** they open your server address (e.g. `https://chat.example.com`), click *Register*, and enter the registration code.

**Desktop app:** the first time it opens it asks for the server address, then works the same way.

To build installers, the easiest route is GitHub: push this folder to a GitHub repo, then push a tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The `Desktop release` workflow builds a Windows `.exe`, macOS `.dmg` and Linux `.AppImage`
and attaches them to a GitHub Release your friends download from.

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

Rough order of what would make it feel more like Discord:

1. Image and file uploads (stored on disk next to the database)
2. Emoji reactions and replies
3. Direct messages
4. Roles and permissions (moderators, private channels)
5. Voice channels with WebRTC (the big one; likely via a small SFU such as mediasoup or LiveKit)
6. Auto-update for the desktop app

## Alternatives

If you would rather run something mature than your own code, these are self-hostable
and Discord-like: [Revolt / Stoat](https://github.com/revoltchat) (closest look and feel),
[Matrix](https://matrix.org) with the Element client (federated, very full-featured, heavier to run),
and [Mumble](https://www.mumble.info) for voice only.
