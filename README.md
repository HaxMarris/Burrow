# Peiskos

A small, self-hosted Discord-style chat for you and your friends. You run the
server on your own machine or a cheap VPS; your friends install the desktop app
(or just open the server's address in a browser) and log in.

*Peiskos* is Norwegian for the cozy feeling of sitting by a crackling fire. It used to be called
Burrow, and the names nobody sees still say so (the `burrow` service and `burrow-data` volume in
Docker Compose, the `~/Burrow` folder, the GitHub repository), so existing servers update without
moving anything.

![Peiskos in the light theme](screenshots/desktop-light.png)

**What works today**

- Accounts with username and password, protected by an optional registration code so strangers can't sign up
- Hearths (shared spaces) you create, with a picture, banner, description, welcome room and rules, and rooms that the host (or anyone whose role allows it) can add, put in order and group under headings
- Invite links that never run out, or that expire after a while or a number of uses, with a page that shows the hearth before joining
- Room topics, slow mode, announcement rooms only some roles can post in, and archived rooms that keep their history
- Muting a room, a hearth or a conversation for a while, or choosing all messages, only @mentions or nothing
- Events with RSVPs and a reminder, group conversations, and your own folders of hearths
- Custom roles with their own name, color and permissions, private rooms, and removing or banning people
- Moderation: timeouts, an audit log, reports, a word filter, deleting many messages at once, rooms some roles can only read, and upload limits per role
- Voice rooms (via [LiveKit](https://livekit.io), self-hosted alongside Peiskos) end-to-end encrypted, with mute and deafen, push to talk, strong noise isolation, a soundboard, a voice changer, calls in direct messages, your choice of microphone, speakers and camera, who's-talking rings, a volume slider for each person, and camera and screen sharing
- Streaming extras: several screens side by side, popping a stream out, a preview of a screen before you open it, the fireside chat over a stream, who's watching, a blurred or swapped camera background, drawing on a shared screen, clips of the last 30 seconds, and "is live" posts
- Image and file sharing: attach, paste or drag in up to 10 files per message, with inline image and video previews
- Emoji reactions and replies (a reply to you counts as a mention)
- Direct messages with your friends and anyone you share a hearth with, one to one or in groups of up to 10
- Profiles: a display name you can change any time, a nickname per hearth, a picture, a banner, a card colour and a short about me
- Friends (add anyone by username, see who's online across all your hearths) and blocking (folds away their messages and stops their DMs, friend requests and pings)
- Account safety: change your username, see and sign out your devices, optional two-step login with an authenticator app, passkeys (Face ID, Windows Hello, a phone or a security key), and password resets by email or by a link from whoever runs the server
- Export my data (a zip of your messages and files) and delete my account (keeping your messages as "Deleted user", or taking them with you)
- Real-time messaging over WebSockets, with typing indicators and online, away, Do not disturb and offline presence
- Custom statuses (with an emoji, cleared after a while if you like), and "Playing …" from the desktop app when you run a game
- A mentions inbox, `@everyone`, `@here` and `@role` mentions (for roles allowed to), quiet hours, and the unread count on the app icon
- Alerts while Peiskos is closed (phones included, once it's on the Home Screen)
- Full message history with infinite scroll back, edit and delete your own messages (↑ edits your last one)
- Formatting: `**bold**`, `*italic*`, `__underline__`, `~~strikethrough~~`, `||spoilers||`, `` `code` ``, coloured code blocks, `# headings`, `> quotes`, lists, clickable links with previews, and `@mentions` (highlighted, and they trigger a desktop notification)
- Unread counts that remember where you stopped reading on every device, a "New" line, and a jump to the first unread message; mark a message unread to come back to it
- Search across your hearths and direct messages, by words, person, room, date or kind (pictures, links, polls…)
- Pinned messages, threads off any message, polls, forwarding, saved messages with reminders, and messages scheduled to send later
- An emoji picker, each hearth's own custom emoji and stickers, and voice messages
- Drafts kept per room, edit history on edited messages, long pastes sent as a text file you can read inline, and "Seen" in direct messages (you can turn it off)
- Desktop app for Windows, macOS and Linux (Electron), Android and iPhone apps (Capacitor), plus the same UI in any browser
- Scandinavian-forest look with light and dark themes


## Layout

```
chat-app/
├── server/     Node.js + TypeScript server (HTTP API, WebSockets, SQLite)
├── client/     The chat UI (plain HTML/CSS/JS), served by the server and bundled into the desktop and phone apps
│   └── js/     The app itself, in parts that index.html loads in order (they share one scope)
├── desktop/    Electron wrapper that packages the client as an installable app
├── mobile/     Capacitor wrapper that packages the client as Android and iPhone apps (see mobile/README.md)
├── scripts/    check-client.mjs, the client check that runs on every pull request
├── Dockerfile, docker-compose.yml
└── .github/workflows/
    ├── checks.yml           On every pull request: server types and tests, client checks, Docker build
    ├── desktop-release.yml  Builds installers on GitHub when you publish a release
    └── mobile-release.yml   Builds the Android app (attached to the release) and sends the iPhone app to TestFlight
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
| `LIVEKIT_URL`       | same address as Peiskos | Where apps reach LiveKit, if not routed through Peiskos's address.   |
| `LIVEKIT_API_URL`   | `http://localhost:7880` | Where Peiskos reaches LiveKit to disconnect removed people (Docker Compose points it at the host). |
| `KLIPY_API_KEY`     | unset (GIFs off)       | Turns on the GIF picker. See *GIFs* below.                          |
| `GIF_RATING`        | `pg-13`                | Which GIFs search shows: `g`, `pg`, `pg-13` or `r`.                 |
| `SMTP_URL`          | unset (email off)      | Mail server for password reset emails. See *Email* below.           |
| `MAIL_FROM`         | the SMTP username      | Who those emails come from, like `Peiskos <you@example.com>`.        |
| `PUBLIC_URL`        | unset                  | The address friends open Peiskos at, for links in emails.            |
| `PUSH_CONTACT`      | Peiskos's GitHub page | A `mailto:` or `https:` address the phone push services can reach you at if something goes wrong. |
| `ADMIN_USERS`       | the first account made | Usernames (comma-separated) that can open the admin page. See *The admin page*. |
| `HEARTBEAT_URL`     | unset                  | An address Peiskos pings every five minutes, for uptime alerts. See *Uptime alerts*. |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`, `BACKUP_S3_PREFIX` | unset (no off-site copies) | Where off-site backups go. See *Backups*. |

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

Voice runs on [LiveKit](https://livekit.io), a media server that Docker Compose starts next to Peiskos.
Voice only is light enough for a Raspberry Pi 4 or 5. The limit is usually your home upload
speed: LiveKit sends each speaker to every listener at about 40 kbps, so a room of 10 needs up to
about 4 Mbps of upload. Video is much heavier: each camera is up to about 1.7 Mbps and each shared
screen up to about 6 Mbps (1080p at up to 60 fps), per person watching. Video is only sent to people who have it open.

Voice and video are end-to-end encrypted: audio and video are scrambled on each person's device and only the others in the
room can unscramble it, so LiveKit (and anyone who got into the server) only ever handles noise. A new
key is made whenever someone joins or leaves, and only people still in the hearth get it. The lock in
the voice bar shows the room is encrypted. Everyone needs an up-to-date app for this.

Removing someone from a hearth, or leaving it, disconnects them from its voice rooms straight away.
Peiskos asks LiveKit to do this directly (`LIVEKIT_API_URL`; Docker Compose sets it up).

1. Copy `.env.example` to `.env` in the same folder as `docker-compose.yml`, and replace the secret
   with the output of `openssl rand -base64 32`.
2. `docker compose up -d --build`. This now starts `livekit` too.
3. Add the two `@livekit` lines above to your Caddyfile and restart Caddy.
4. On your router, forward **TCP 7881** and **UDP 7882** to the server, alongside 80 and 443.

The host then adds a room with **+** next to *Rooms* and picks *Voice room*. Click a voice room to
join; the bar above your name has mute, deafen (hear nobody and mute your mic; everyone in the hearth
sees it), camera, screen sharing, the video view and leave, plus a sliders button for your
microphone, speakers and camera. Click someone in a voice room to turn them up or down (0% to 200%,
only for you).

Turning on your camera or sharing your screen shows everyone's video in place of the chat. Others see
a camera icon or a red **LIVE** tag next to your name, and open the video with the grid button in the
voice bar (or by clicking the voice room). Click a video to make it bigger, use the button in its
corner (or double-click) for full screen, and **Back to chat** to return. The member list hides while you watch. A shared screen with
sound starts muted; hover over it for its mute button and volume slider (0% to 200%, only for you).
Peiskos remembers what you pick for each person. In the desktop app you pick a screen or window from Peiskos's
own list, and *Smooth motion* (60 fps, for games and video) or *Sharp text* (keeps text crisp, for
documents and code); in a browser, **Share** asks whether to share a browser tab (with its sound) or your
screen or a window, and which of the two. Sound: on Windows 10 (version 2004 or later) and 11,
the desktop app shares only the sound of the window you picked, or everything except Peiskos when you
share a whole screen, so people don't hear themselves back. In Chrome or Edge, sharing a browser tab
shares that tab's sound, and sharing a whole screen on Windows shares all of the computer's sound.
Other cases share no sound. On a Mac, the first share asks for *Screen Recording* permission in System
Settings, and Peiskos may need a restart after you allow it.

While you watch, the buttons in a video's corner:

- **Pen**: draw on a shared screen. Everyone watching sees it, in your own color, and it fades after a few
  seconds. When the desktop app shares a whole screen, the person sharing sees the drawing on that screen too.
- **Clock**: keep clips of someone's stream; press it again to save the last 30 seconds (or so) and post it in
  a room or download it. The recording happens on your own computer, only while it's on.
- **Speech bubble**: the fireside chat over a big or full screen video.
- **Pop out**: the video in its own small window that stays on top, so you can go back to chatting.

With two or more screens shared, **Screens side by side** shows them next to each other. The eye in a screen's
corner counts who's watching (hover for names). Hover over **Watch screen** at the fire for a small preview of
it first. Everything people at a fire tell each other for these is sealed with the voice key, like the voice.
*Edit hearth* can pick a room for go-live posts: sharing your screen then posts that you're live there, with a
**Join and watch** button, and the post says when it ended.

### GIFs

The **GIF** button in the message box searches [KLIPY](https://klipy.com), a free GIF library (Google shut down Tenor's API in June 2026). It needs a free key:

1. Sign up at [partner.klipy.com](https://partner.klipy.com).
2. Open **API Keys**, choose **Add Platform** (call it Peiskos), and copy the key it makes.
3. Add `KLIPY_API_KEY=<the key>` to `.env` and run `docker compose up -d`.

Searches and previews go through your Peiskos server, so the key never reaches anyone's app and KLIPY doesn't see your friends' addresses (it gets an anonymous id per person instead). A GIF that's sent is saved on your server like any shared picture, so old messages keep working. If KLIPY ever limits your key, ask for production access in its Partner Panel.

### Phone alerts

Alerts while Peiskos is closed (on phones, and in Chrome, Edge and Firefox) work with no setup: each person ticks *Alert me when Peiskos is closed* in their account. They need Peiskos on `https://` (see *Letting friends reach it*). On an iPhone or iPad, they first add Peiskos to the Home Screen (Share › Add to Home Screen) and turn it on from there; that also gives Peiskos an app icon with the unread count.

### Email

Email is optional. With it, someone who forgets their password can get a code by email from *Forgot your password?* on the login screen; without it, a forgotten password means a new account. Peiskos needs a mail server it can send through. The easiest is a Gmail account (a spare one is best, since emails come from that address): turn on 2-Step Verification, make an app password at https://myaccount.google.com/apppasswords, and use its 16 letters as the password below with `smtp.gmail.com`. Your email provider, Amazon SES or Mailgun work too. Put it in `.env`:

```sh
SMTP_URL=smtps://you%40example.com:app-password@smtp.example.com:465
MAIL_FROM=Peiskos <you@example.com>
PUBLIC_URL=https://chat.example.com
```

Write `@` in the username as `%40`. Port 465 starts encrypted (`smtps://`); for port 587 use `smtp://`, and Peiskos switches to encryption before sending the password (it refuses to send it unencrypted). Then signing up asks for an email address, and it counts straight away, so a new account can reset its password from day one. People whose accounts are older add theirs under *Email* in their account (a reminder pops up once a day until they do), confirming it with a code. Peiskos only sends the code that confirms an address and the code that resets a password, never anything else.

Without email (or for someone who lost their email too), whoever runs the server can make a one-hour reset link:

```sh
docker compose exec burrow node --no-warnings server/src/reset-link.ts their-username
```

Send them the link it prints (it uses `PUBLIC_URL`). Add `--two-step-off` if they also lost the phone with their authenticator app and their recovery codes.

### Security

- Everything travels encrypted: Caddy serves HTTPS (and Peiskos then tells browsers to always use it), and voice uses WebRTC's built-in encryption. Passwords are stored hashed with scrypt.
- Too many wrong passwords lock that account's login for 15 minutes; registration code guesses are limited per address the same way.
- Logins expire after 30 days without use. Changing your password logs you out everywhere else, and *Your devices* in the account shows every login and can sign any of them out. The database only keeps a hash of each login, so a copy of it (a backup, say) can't be used to log in as anyone.
- Two-step login is optional: each person can turn it on in their account, after which their password also needs a code from an authenticator app (or one of 10 one-time recovery codes).
- Passkeys work in the web app over HTTPS (they belong to the site's address, so set `PUBLIC_URL` if people reach Peiskos by more than one name). The desktop app logs in with a password.
- With Docker, port 3000 only listens on the server itself, so the only way in is through Caddy. Set `BURROW_BIND=0.0.0.0` in `.env` if you run without a reverse proxy.
- The web app and the desktop app only run their own scripts (a strict Content-Security-Policy), which blunts any injected code.
- Each name in `ADMIN_USERS` belongs to the first account seen with it. If that person changes their username they stop being an admin (add the new name), and whoever takes the old name doesn't become one. A listed name nobody has yet goes to whoever signs up with it first, so the admin page warns about those.
- Sending is limited to a burst of 60 messages and then about one a second per person, and voice tokens are only good for joining for 15 minutes.
- A weekly check on GitHub (`.github/workflows/security.yml`) looks for known holes in Peiskos's packages and makes sure those protective headers are still sent, and Dependabot proposes updates to packages, Docker images and workflows.

### The admin page

Whoever runs the server finds **Server admin** in their menu (their picture, top right). It's the
first account made on the server, unless `ADMIN_USERS` in `.env` names others. It has:

- **Overview:** how many people and messages there are, who's in voice, how much space files,
  the database and backups take and how much disk is left, and a list of checks (https, who can
  sign up, backups, off-site copies, uptime monitor, updater). *Clean up unused files* removes files
  nothing points at any more, such as pictures from deleted hearths; it also runs by itself daily.
- **People:** everyone with an account, when they were last on, what they've sent and uploaded.
  *Reset link* makes a one-hour link that sets a new password (send it to them); *Log out* signs
  someone out everywhere; *Delete* removes their account (keeping or deleting their messages), and
  hearths they host go to whoever has been in them longest.
- **Signing up:** who can make an account (anyone, people with the registration code, or only people
  with a signup link), and signup links: each works for 1 to 50 accounts and can run out after a
  day, a week or a month. Someone opening one sees the sign-up form with no code to type.
- **Backups:** back up now, and restore an earlier day (Peiskos restarts on it; see below).
- **Crashes:** errors from people's apps, grouped, with how often they happened, to send to whoever
  fixes Peiskos.

### Backups

Peiskos copies its database once a day and keeps the last 7 copies (`BACKUP_KEEP`). They sit on the
same disk as the server, so also have them copied somewhere else: with the `BACKUP_S3_` settings,
each day's backup and every uploaded file go to S3-style storage too. Any of these work:

- **Backblaze B2** (10 GB free): make a private bucket, then *Application Keys › Add a New Application
  Key* for that bucket. `BACKUP_S3_ENDPOINT` is the bucket's *Endpoint* with `https://` in front, and
  `BACKUP_S3_REGION` its middle part (like `us-west-004`).
- **Cloudflare R2** (10 GB free): make a bucket, then *Manage R2 API Tokens › Create API token* with
  *Object Read & Write*. The endpoint is `https://<account id>.r2.cloudflarestorage.com`; the region
  is `auto`.
- **Amazon S3**, Wasabi, MinIO and others: the bucket, its region, and an access key that can read,
  write and list it (leave the endpoint out for Amazon).

```sh
BACKUP_S3_BUCKET=my-burrow-backups
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
BACKUP_S3_REGION=us-west-004
BACKUP_S3_KEY_ID=your-key-id
BACKUP_S3_SECRET=your-secret-key
```

Peiskos never deletes anything there; set the bucket to drop old versions if you like. The admin
page shows when the last copy worked.

**Restoring:** pick a day under *Backups* on the admin page and press *Restore*; Peiskos restarts on
that copy. The database it replaces is kept next to it as `chat.db.before-restore-…`. Or from SSH,
which also reaches the off-site copies:

```sh
docker compose exec burrow node --no-warnings server/src/restore.ts             # lists them
docker compose exec burrow node --no-warnings server/src/restore.ts 2026-10-05  # picks one
docker compose restart burrow                                                   # finishes it
```

On a brand new server (the old one is gone), put the same `.env` in place, start Peiskos once, then
run the restore with `--uploads` after the date to bring back every uploaded file too.

### Privacy policy and terms

Peiskos serves a privacy policy at `/privacy` and terms of use at `/terms`, and the signup screen links to both (App Store and Google Play listings need their addresses too). They describe what this code keeps, so they're right for any server. Put your name and a contact address in `.env` so people know who runs it:

```
LEGAL_NAME=Maxwell
LEGAL_CONTACT=hello@example.com
```

Without `LEGAL_CONTACT` the pages use the address in `MAIL_FROM`. The wording lives in `server/src/legal.ts`; it isn't legal advice, so have it checked if your server is open to the public.

### Uptime alerts

To get an email when Peiskos goes down, make a free check at [healthchecks.io](https://healthchecks.io)
(period 5 minutes, grace 10), and put its ping address in `.env` as
`HEARTBEAT_URL=https://hc-ping.com/…`. Peiskos pings it every five minutes; when the pings stop, you
hear about it. Monitors that check from outside, like UptimeRobot, can watch
`https://your-address/api/health` instead, which also catches Caddy or the network being down.

### Updating from the admin page

Updating is normally `git pull && docker compose up -d --build` over SSH. To do it from the admin
page instead, add `updates` to `COMPOSE_PROFILES` in `.env` (`COMPOSE_PROFILES=voice,updates`) and
run `docker compose up -d`. That starts a small updater next to Peiskos that checks for new versions
hourly; the admin page then lists what's new and has *Update now*, which pulls, rebuilds and
restarts Peiskos (a minute or two away; voice reconnects after). The updater can control Docker on
the machine, which is what lets it rebuild Peiskos, so leave it off if you'd rather not.

## 2. Get your friends the app

**Browser:** they open your server address (e.g. `https://chat.example.com`), click *Register*, and enter the registration code.

**Desktop app:** it connects to `https://peiskos.app` by itself. To use your own server instead, click *Use a different server* on the login screen and enter its address.

**Phone apps:** the Android app is attached to each release as `Peiskos-x.y.z.apk` (on an Android
phone, the login page shows a *Get the Android app* button), and iPhone friends get the iPhone app
through Apple's TestFlight. Like the desktop app they connect to `https://peiskos.app` unless told
otherwise, and keep a voice call going with the screen off. Setting them up (a signing key for
Android, an Apple developer account for iPhones) is in [mobile/README.md](mobile/README.md).

**Or from the browser:** on Android, open the server address in Chrome and pick *Install the app* from your menu
(your picture, top right) or Chrome's own *Install app*; Peiskos then has its own icon, opens without
the browser around it, shows up in the share menu of other apps, and can send alerts while closed.
On an iPhone or iPad, use Safari's Share › *Add to Home Screen*. Both need Peiskos on `https://`.

To build installers, let GitHub do it: on the repo page go to **Releases → Draft a new release**,
type a new tag such as `v0.1.0`, and click **Publish release**. The `Desktop release` workflow then
builds a Windows `.exe`, two macOS `.dmg`s (`arm64` for Apple chips, M1 and later, and `x64` for
older Intel Macs) and a Linux `.AppImage` and attaches them to that release, usually within about
ten minutes. Send your friends the release link, or your server's login page, whose download buttons
pick the right file (Macs get the Apple-chip one, with a link to the Intel one).

**Updates:** the desktop app checks for a newer release when it starts and every six hours.
On Windows, Linux and signed Mac builds it downloads the update in the background and asks to
restart; if they pick *Later*, it installs the next time they quit. An unsigned Mac build shows a
*Download* button that opens the release page instead, because macOS only lets signed apps update
themselves. Release tags must look like
`v1.2.3`; the tag becomes the app's version number.

You can also run the workflow by hand from the **Actions** tab to get test builds without publishing anything.

To build locally instead (each OS builds its own installer best):

```sh
cd desktop
npm install
npm start        # run it without packaging
npm run dist     # build an installer for the current OS into desktop/dist/
```

Without signing, Windows SmartScreen says "Windows protected your PC" (click *More info → Run
anyway*) and macOS needs right-click → *Open* the first time (on recent macOS: System Settings ›
Privacy & Security › *Open Anyway*).

### Signing the desktop app

Signing makes those warnings go away and lets Mac builds update themselves. It's optional and costs
money, so the release workflow signs only when you've added the secrets below (repo **Settings ›
Secrets and variables › Actions › New repository secret**); without them it builds unsigned, as above.

**Mac** (needs an [Apple Developer Program](https://developer.apple.com/programs/) membership, $99 a year):

1. In Xcode (*Settings › Accounts › Manage Certificates › + › Developer ID Application*) or on the
   developer website, create a *Developer ID Application* certificate, then export it from Keychain
   Access as a `.p12` file with a password.
2. Add the secrets `MAC_CERTIFICATE` (the `.p12` as base64: `base64 -i cert.p12 | pbcopy`) and
   `MAC_CERTIFICATE_PASSWORD`.
3. For notarizing (Apple checks the app, so it opens with no warning at all): `APPLE_ID` (your Apple
   account's email), `APPLE_APP_SPECIFIC_PASSWORD` (make one at [account.apple.com](https://account.apple.com)
   › Sign-In and Security › App-Specific Passwords) and `APPLE_TEAM_ID` (on the developer website
   under Membership).

**Windows:** certificates now have to live on special hardware, so the practical choice is
[Azure Artifact Signing](https://azure.microsoft.com/products/artifact-signing) (formerly Trusted
Signing, about $10 a month). Set up an account and a certificate profile there, make an app
registration with the *Certificate Profile Signer* role on that account, then add the secrets
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT` (e.g.
`https://eus.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and
`AZURE_PUBLISHER_NAME` (the name on the certificate). If you have an older `.pfx` certificate
instead, add it as `WIN_CERTIFICATE` (base64) and `WIN_CERTIFICATE_PASSWORD`. SmartScreen can still
warn for a while after you first sign, until enough people have installed it.

Then publish a release as usual.

## 3. Using it

Peiskos has its own names for things: a **hearth** is a shared space for one group of friends (what Discord calls a server), and each hearth has **rooms** (channels).

- Click **+** under *Your hearths* to light a new hearth, or join one with an invite link or code.
- The gear next to the hearth's name opens its settings. **Invite people** has a link that never runs out, and makes links that expire after a while or a number of uses; anyone in the hearth can make one. Opening a link in a browser shows the hearth's picture, banner and description before joining. **Notifications** mutes the hearth or sets it to all messages, only @mentions or nothing. The host, and roles allowed to *edit the hearth*, find **Edit hearth** there: its name, description, picture, banner, welcome room (where new people land) and rules (new people accept them before they can chat). The host can also hand the hearth to someone else there, and delete it; everyone else can leave. People whose role lets them ban also see who's banned there, and can unban them. People who can manage roles open **Roles** there.
- **Roles:** every hearth starts with a *Moderator* role. Under **Roles** you can make your own (like *Admins* or *Friends*), pick a color, choose what each one can do (manage rooms, delete messages, pin messages, remove people, time people out, ban people, see the audit log, manage roles, edit the hearth, manage invites, manage emoji and sounds, manage voice, mention @everyone and roles), and set how big a file each role can share. Only roles allowed to *pin messages* can pin in a hearth (anyone can in a DM), and move them up or down. Names show in the color of their highest role. People can only change roles, and remove people, below their own highest role, and can't hand out permissions they don't have. A role with no permissions is just a colored label.
- People who can manage rooms add rooms and headings with the **+** next to *Rooms*, where *Arrange rooms* also puts them in order (on a computer you can drag them too). Anyone can fold a heading away. The gear that appears when you hover over a room changes its name, topic, slow mode and who can see it, makes it an announcement room that only some roles can post in, picks roles that can only read it, archives it or deletes it. A private room is only seen by people who manage rooms, plus the roles and people you tick.
- The bell at the top of a room mutes it for a while, or sets it to all messages, only @mentions or nothing. Right-clicking a room in the list does the same.
- **Events** above the rooms plans a game night: pick a time and a room, and people answer *Going*, *Maybe* or *Can't go*. Everyone going or maybe going gets a reminder 15 minutes before.
- Your account (your picture, top right) and the sliders button on the voice bar have voice and video settings: which microphone, speakers or headset and camera to use (with a mic test and a camera preview), your volume and everyone's volume, noise isolation, voice quality (48, 64 or 96 kbps), and your camera background: blurred, or a picture of your own (done on your own device with [MediaPipe](https://ai.google.dev/edge/mediapipe), before your camera is sent). Noise isolation has four levels: *Off* (for music), *Light* (the browser's own filter), *Strong* (the default, [RNNoise](https://github.com/xiph/rnnoise)) and *Strongest* ([GTCRN](https://github.com/Xiaobin-Rong/gtcrn); takes out the most noise but makes voices a little flatter). Both run on your own device before your voice is encrypted. Whenever noise isolation is on, a rumble filter also takes out sound under 90 Hz (desk thumps, hum). Picking speakers works in Chrome, Edge and the desktop app; Safari, iPhones and Firefox play through whatever the system picks. Account also has sound settings: chimes for new messages and for people joining or leaving your voice room, and how loud they are.
- **How you talk** in the voice settings: *When you speak* (by default only while RNNoise hears you talking, which leaves out typing and noise between your words; or turn that off and set a sensitivity line while testing) or *Push to talk* (hold \` by default, or any key or mouse side button). Mute and deafen have keys too (Ctrl+Shift+M and Ctrl+Shift+D). In the desktop app these keys work while another program is in front, even a game; on a Mac, allow Peiskos under System Settings › Privacy & Security › Accessibility first. The settings also have a voice changer (deeper, higher, robot, echo, radio, cave), *Music mode* (stereo at 128 kbps with no noise isolation, for playing an instrument), and whether to play soundboard sounds.
- At the fire: **Sounds** opens the hearth's soundboard (people who manage emoji and sounds add clips of up to 10 seconds in the hearth settings), and **Listen** plays a YouTube video for everyone at the fire, in step; anyone can pause, skip or change it. Each voice room's gear sets how many seats it has and whether its fireside chat is kept after everyone leaves. *Edit hearth* picks an AFK fire that people idle for a while are moved to, muted. Who's talking shows in the room list even when you're not at that fire.
- People whose role can *manage voice* click someone at a fire to move them to another fire, disconnect them, or mute them for everyone (until they're unmuted, even if they rejoin). They can also sit at a full fire.
- The phone button at the top of a direct message calls the other person (or everyone in a group): they hear it ring and can answer or decline. Anyone in the conversation can join a call that's going.
- Hover over someone in the member list and click **⋯** to give them roles, time them out (they can read but not write or talk, from a minute to a week), or remove or ban them, depending on what your roles allow.
- Anyone can report a message from its **⋯** menu. People who can delete messages see the reports under **Reports** in the hearth's settings, where they jump to the message, delete it or dismiss the report; the same menu can delete a message and everything after it (up to 100). **Edit hearth** has a word filter that either stops messages with those words or lets them through and reports them, and the hearth's upload limit. Roles allowed to *see the audit log* find who removed, banned, timed out, deleted or changed what under **Audit log**.
- The speech-bubble tile above your hearths holds your direct messages. Start one with its **+** (tick several people for a group conversation), or click someone in a hearth's member list. A group's gear renames it, adds people or leaves it.
- In the hearth list (*more* on a computer, or the hearth button on a phone), the folder button next to each hearth puts it in one of your own folders.
- **Your account** (in your menu, top right) has four tabs. *Profile*: picture, banner, display name, about me and card colour. *Settings*: theme, notifications, voice and sounds. *Login and security*: username, email, password, two-step login, passkeys and your devices. *Your data*: export everything, or delete your account. If the server has email, add your address under *Email*, so *Forgot your password?* on the login screen can send you a code.
- Click anyone's name (in the member list or on a message) for their card: about me, the hearths you share, and buttons to message them, add them as a friend or block them. Click yourself to change your nickname in that hearth.
- **Friends** is at the top of your direct messages: who's online, requests to accept, and anyone you've blocked. Add someone by their username there, even if you don't share a hearth.
- Your picture (top right, or *You* on a phone) sets you to *Online*, *Away* or *Do not disturb* (no sounds or alerts), and sets a custom status. Peiskos marks you away by itself after 10 minutes without touching it. The **@** next to it is your inbox of mentions and replies, with the number you haven't read.
- Your account has the notification settings: alerts while Peiskos is closed, quiet hours (no sounds or pop-ups, and silent phone alerts, between two times), and, in the desktop app, whether to show the game you're playing.
- Type `@everyone` (everyone who can see the room), `@here` (only people online) or `@` and a role's name to ping them all. Only roles allowed to *mention @everyone and roles* can; for everyone else it's just text.
- The **GIF** button next to the message box opens trending GIFs; type to search, and tap one to send it.
- Type `/` in the message box for commands: `/roll 2d6` (or `d20`, `3d8+2`), `/flip`, `/poll Question | answer | answer` (or just `/poll` for the poll maker), `/gif cats` (also `/giphy`), `/me waves`, `/shrug` and `/spoiler text`.
- **Bots and webhooks** in a hearth's settings (for people who can edit the hearth) connect other things. A *webhook* posts in one room: GitHub, a home server or a script sends `{"content": "Build passed"}` (or Slack's `{"text": "…"}`) to its address, up to 30 a minute. A *bot* gets its own account and token, and uses the same API the apps do with `Authorization: Bearer <token>` (for example `POST /api/channels/<room id>/messages` with `{"content": "hi"}`, and `/ws?token=<token>` for live events). Their messages are marked BOT.
- Pictures and videos load only as they scroll into view, and keep their space so the chat doesn't jump. Videos show a still from the video until you press play, so nothing more downloads until then. A video over 20 MB (or over the limit) gets a **Shrink** button before it's sent, which makes it 720p; it plays the video through once on your device, so it takes as long as the video (Chrome, Edge, Firefox and the desktop app).
- If your connection drops, Peiskos reconnects by itself when it can, fetches only the messages you missed, and puts you back at the fire you were at. With no connection at all it still opens (on the web, once you've used it there over `https://`) and shows your hearths and the latest messages in rooms you'd opened on that device; messages you write wait in a *Waiting to send* list above the message box (with ✕ to drop one) and go out once you're back.
- The **+** in the message box uploads files, makes a poll, sends a sticker, or sends what you've typed later. The smiley opens every emoji (and your hearths' own), and the microphone records a voice message.
- Each message's **⋯** menu pins it, starts a thread, forwards it, saves it (or reminds you about it later), marks it unread, or shows its edit history. Your saved and scheduled messages are in your menu, top right.
- The magnifier at the top of a room searches messages; **Ctrl+F** (⌘F on a Mac) opens it from anywhere. The pin next to it lists the room's pinned messages.
- **Keyboard:** **Ctrl+K** jumps to any room, conversation or hearth by typing part of its name (unread ones first), **Alt+↑/↓** moves to the room above or below, and **Alt+Shift+↑/↓** to the next unread one. **Ctrl+/** (or *Keyboard shortcuts* in your menu) lists them all. Rooms, people and menus can all be reached with Tab and opened with Enter, and screen readers read out the buttons and new messages.
- **On a phone:** swipe a message to the right to reply to it, swipe in from the left edge of a room to go back to the rooms, and swipe along a room's name at the top for the next or previous room. On Android, sharing a photo, file or link from another app to Peiskos asks which room it goes to, then puts it in the message box.
- *Settings* in your account also has **Display**: compact messages (plain lines instead of cards), text size (80% to 150%) and less motion (or follow your system's setting). These are kept per device.
- **In the desktop app:** closing the window keeps Peiskos running in the tray (the menu bar on a Mac), with a red dot when something's unread; quit from the icon's menu. *Settings › App* turns that off, and can start Peiskos when the computer starts. **Switch server** in your menu adds other people's Peiskos servers and switches between them, staying logged in to each. Ctrl+plus and Ctrl+minus change the text size.
- People whose role lets them *manage emoji* add a hearth's own emoji and stickers in its settings; type `:name:` to use one.
- The moon button in your profile card switches between the light "birch" theme and the dark "pine night" theme. By default it follows your system setting.
- Your account also has a **theme color** wheel: pick any color (nearer the middle is softer) or one of the presets, and Peiskos's backgrounds and accents follow it in both light and dark. *Back to ember* undoes it.
- **Fun extras:** time at fires counts up. The flame button at the top of the fire opens *By the fire*: little pixel pictures to keep beside your seat that everyone sees (a mug of cocoa at 1 hour, up to a wolf at 150), and from 2 hours you can toast a marshmallow by clicking the fire (it might turn out golden, or catch fire). The hearth's shared hours unlock other fires (birch logs, sparks, a blue flame) and skies above them (a starry night, a full moon, northern lights, shooting stars), which people who can edit the hearth pick. Time at the AFK fire doesn't count. For now everything is unlocked from the start, while Peiskos is being tested; put `FIRE_UNLOCKS=hours` in `.env` to make them wait for those hours again (the hours count either way).
- Peiskos follows the seasons: snow in winter, blossom in spring, fireflies in summer and leaves in autumn around the fire, plus touches for Halloween, Christmas, New Year and midsummer (northern hemisphere). *Seasonal touches* under *Settings › Display* turns them off, and *less motion* stills them.
- Add your **birthday** (day and month only) in your profile. On the day, a cake shows next to your name and your hearths get a card to wish you well.
- **Message of the day** in the hearth's menu (for people who can edit the hearth) takes a list of lines or photos; one shows above the rooms each day, in turn, and anyone can hide it until tomorrow.
- **Year in review** in the hearth's menu (and above the rooms in December and January) shows the hearth's year: messages, busiest rooms and day, favourite reactions, who talked most, hours around the fire, new faces, and your own numbers. Only rooms you can see count.

## Development

```sh
cd server
npm install
npm run dev        # restarts on changes; open http://localhost:3000
npm test           # end-to-end API and WebSocket tests
npm run typecheck  # TypeScript's type check
node ../scripts/check-client.mjs   # the client's scripts: load order and duplicate names
```

Client changes need only a browser refresh. The client is plain scripts in `client/js/`, loaded in
order by `index.html` and sharing one scope, so something one part runs straight away can only use
what earlier parts set up (functions it calls later, from a click or a message, can live anywhere).
`check-client.mjs` catches mistakes there. The API is plain JSON over HTTP with a bearer token, and
live events come over `/ws?token=…`; see `server/src/app.ts`.

Every pull request runs **Checks** on GitHub: the type check, the tests, the client check with ESLint,
a syntax check of the desktop app and a Docker build.

### Load test

How many people can the server handle? This starts a throwaway Peiskos next to the real one (its own
empty database, deleted afterwards) and adds people in steps, all chatting in one busy room, until
messages get slow:

```sh
docker compose exec burrow node --no-warnings server/src/load-test.ts
```

For voice seats, use LiveKit's own tool from your computer (install it with `winget install LiveKit.LiveKitCLI`
on Windows, or `brew install livekit-cli`), with the key and secret from `.env`. This sits 10 pretend people
at a fire, all talking, with 4 cameras on:

```sh
lk load-test --url wss://your-peiskos-address --api-key KEY --api-secret SECRET --room loadtest --audio-publishers 10 --subscribers 10 --video-publishers 4 --video-resolution medium --layout 5x5 --duration 1m
```

Measured on a 4-core test machine (the load generators ran on the same machine, so a server on its own does a bit better):

| Chat, one room, everyone sending a message every 5 seconds | Messages reach everyone (95%) | Server CPU |
| --- | --- | --- |
| 100 people | 7 ms | 9% of one core |
| 200 people | 14 ms | 26% |
| 300 people | 42 ms | 48% |
| 400 people | 340 ms | 77% |
| 500 people | 4 s, and some lost | maxed out |

| Voice, everyone talking at once | LiveKit CPU | Sent out |
| --- | --- | --- |
| 10 at a fire | 22% of one core | 2 Mbps |
| 25 at a fire | 67% | 12 Mbps |
| 10 at a fire, 4 cameras | 27% | 22 Mbps |

The $12 Lightsail box has 2 vCPUs and is a burstable plan, so expect around half of this for long stretches:
a few hundred people chatting, or a couple of full fires with cameras, before it slows down. Bandwidth runs
out before CPU for video: each camera at medium quality is about 0.5 Mbps for every person watching it.

## Roadmap

Done: auto-update for the desktop app, voice rooms, image and file sharing, reactions and replies, profile pictures and password changes, direct messages, custom roles with private rooms, per-person voice volume, notification sounds, camera and screen sharing, a GIF picker, hearth pictures, the chat and messages update (search, pins, threads, polls, link previews, voice messages, custom emoji and stickers, reminders, scheduled messages and more), the rooms, hearths and organization update (headings and room order, topics, slow mode, announcement and archived rooms, invite links that run out, banners, rules and a welcome room, muting, events, group conversations and folders), and the voice and Campfire update (push to talk and hotkeys, voice sensitivity, soundboard, moving and muting people, AFK fire, seat limits, calls, listen together, kept fireside chat, music mode and a voice changer), and the notifications and presence update (away and Do not disturb, custom statuses, playing now, a mentions inbox, @everyone and @role mentions, quiet hours, the app icon count, alerts while Peiskos is closed), password resets by email, the moderation update (timeouts, an audit log, reports, a word filter, bulk delete, read-only roles, more role permissions and upload limits per role), the video and streaming update (side by side, pop out, previews, chat over a stream, who's watching, camera backgrounds, tab sharing with sound, clips, drawing and go-live posts), the profiles, friends and DMs update (display names, nicknames, profile cards, friends, blocking, username changes, devices, reset links, two-step login, passkeys, data export and account deletion), and the speed and reliability update (clean reconnects, lazy-loaded pictures, video thumbnails and shrinking, the client split into parts, checks on every pull request and a load test), the apps update (Android install and sharing into Peiskos, swipes, working offline, the tray and starting with the computer, signed Mac and Intel Mac builds, Windows signing, keyboard shortcuts and a quick switcher, accessibility, compact messages, text size and several servers in the desktop app), and the hosting, admin and security update (an admin page, off-site backups and one-click restore, signup links, storage clean-up, uptime alerts, updating from the app, crash reports, a weekly security check, bots, webhooks and slash commands), and the fun extras update (seasons, things to keep by your seat, marshmallows, fire looks, birthdays, a message of the day and a year in review), and games at the fire (Melon Bomber for up to four people in a call).

Ideas for later: text message encryption, sharing one program's sound on macOS.

## Alternatives

If you would rather run something mature than your own code, these are self-hostable
and Discord-like: [Revolt / Stoat](https://github.com/revoltchat) (closest look and feel),
[Matrix](https://matrix.org) with the Element client (federated, very full-featured, heavier to run),
and [Mumble](https://www.mumble.info) for voice only.
