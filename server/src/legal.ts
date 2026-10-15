// The privacy policy and terms at /privacy and /terms. App stores ask for both, and the signup
// screen links to them. They describe what this code actually keeps, so change them together.
// Whoever runs the server fills in their name and a contact address in .env (LEGAL_NAME, LEGAL_CONTACT).

export interface LegalOptions {
  /** Who runs this server, as people should see it ("Maxwell"). */
  name?: string;
  /** Where people write about their data or a problem: an email address or a web address. */
  contact?: string;
  /** The address people open Peiskos at. */
  publicUrl?: string;
  /** How many days of daily backups are kept (0 when backups are off). */
  backupDays: number;
  /** Whether off-site backups are on. */
  offsite: boolean;
}

/** The date these were last changed. Bump it whenever the wording changes. */
export const LEGAL_UPDATED = '15 October 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The address in a MAIL_FROM like `Peiskos <you@example.com>`. */
export const mailAddress = (from?: string) => from?.match(/<([^>]+)>/)?.[1] ?? (from?.includes('@') ? from.trim() : undefined);

function contactHtml(contact?: string) {
  if (!contact) return 'the person who runs this server (ask in any hearth they host, or message them directly)';
  const href = /^https?:\/\//i.test(contact) ? contact : `mailto:${contact}`;
  return `<a href="${esc(href)}">${esc(contact)}</a>`;
}

function page(title: string, body: string, o: LegalOptions) {
  const site = o.publicUrl ? esc(new URL(o.publicUrl).host) : 'this server';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Peiskos</title>
<link rel="icon" href="/icon.svg" />
<style>
  @font-face { font-family: 'Fraunces'; src: url(/fonts/fraunces-600.woff2) format('woff2'); font-weight: 600; font-display: swap; }
  @font-face { font-family: 'Nunito Sans'; src: url(/fonts/nunito-sans.woff2) format('woff2'); font-weight: 200 1000; font-display: swap; }
  :root { --bg: #f6f0e7; --surface: #fffaf3; --text: #2f2620; --strong: #1f1813; --muted: #7d6d60; --line: #e2d6c4; --accent: #c4561c; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1f1813; --surface: #2a211b; --text: #e9dfd3; --strong: #fff6ec; --muted: #a8998b; --line: #3b2f27; --accent: #f08a4b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 'Nunito Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 8px 24px 24px; }
  h1, h2 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; color: var(--strong); line-height: 1.25; }
  h1 { font-size: 2rem; margin: 24px 0 4px; }
  h2 { font-size: 1.25rem; margin: 28px 0 8px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); font-size: .9rem; }
  ul { padding-left: 1.25em; }
  li { margin: 4px 0; }
  nav { display: flex; gap: 16px; margin-bottom: 16px; font-weight: 700; }
  nav a { text-decoration: none; }
</style>
</head>
<body>
<main>
  <nav><a href="/">Peiskos</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
  <div class="card">
    <h1>${title}</h1>
    <p class="muted">For Peiskos at ${site}${o.name ? `, run by ${esc(o.name)}` : ''}. Last updated ${LEGAL_UPDATED}.</p>
    ${body}
  </div>
</main>
</body>
</html>`;
}

export function privacyPage(o: LegalOptions) {
  const runBy = o.name ? esc(o.name) : 'the person who runs this server';
  const backups = o.backupDays > 0
    ? `<li><b>Backups.</b> The server copies everything once a day and keeps the last ${o.backupDays} days of copies${o.offsite ? ', on the server and in a separate storage service' : ''}, so something you delete can stay in a backup for up to ${o.backupDays} days before it's gone for good.</li>`
    : '';
  return page('Privacy policy', `
    <p>Peiskos is a place to chat, talk and hang out with friends. It runs on its own server, managed by ${runBy}. There are no ads, nothing is sold, and there's no tracking or analytics. This page says what the server keeps, who can see it, and how you get it back or deleted.</p>

    <h2>What Peiskos keeps</h2>
    <ul>
      <li><b>Your account:</b> your username, display name, password (scrambled so it can't be read), email address if you give one, and whatever you add to your profile: picture, banner, bio, birthday, color and status.</li>
      <li><b>What you post:</b> messages and their earlier versions when you edit them, reactions, files, pictures, voice messages, polls, stickers and emoji you add, saved messages and reminders.</li>
      <li><b>Where you are:</b> the hearths and groups you're in, your roles, your friends and the people you've blocked, and what you've read.</li>
      <li><b>Logins:</b> for each device you're logged in on, its name, its IP address, and when it was last used, so you can see them under Login and security and log them out. Logins you don't use for 30 days end on their own. Passkeys and two-step login keep only what's needed to check them.</li>
      <li><b>Time at the fire:</b> how long you spend in voice, which unlocks fire decorations.</li>
      <li><b>Playing now:</b> if you turn on "Show the game I'm playing" in the desktop app, the name of the game. Nothing else about your computer leaves it.</li>
      <li><b>Notifications:</b> if you turn them on, the address your browser or phone gives the server to deliver them.</li>
      <li><b>Crash reports:</b> when the app hits an error, the error message, which app it was, and your account, so it can be fixed. Only the latest 200 are kept.</li>
      <li><b>Safety records:</b> reports you send or that are made about you, bans, and a log of moderator actions in each hearth.</li>
    </ul>

    <h2>What Peiskos doesn't keep</h2>
    <ul>
      <li>Voice calls, video and screen shares aren't recorded. Voice is end-to-end encrypted, so the server passes it along without being able to listen.</li>
      <li>Fireside chat (the text chat at a fire) is gone once everyone leaves the fire.</li>
    </ul>
    <p>Text messages and files are not end-to-end encrypted. They're stored on the server so they're there on all your devices, which means ${runBy} could technically read them. They won't, except to deal with a report or a legal obligation.</p>

    <h2>Who sees what</h2>
    <ul>
      <li><b>Other people</b> see what you post in the hearths, rooms and conversations you share with them, and your profile.</li>
      <li><b>Moderators and hosts</b> of a hearth can see reports about it and remove messages there.</li>
      <li><b>The server's cloud provider</b> stores the server's disk, and backups go to a storage service if they're turned on. Neither uses your data for anything else.</li>
      <li><b>Email:</b> if you give an address, it's used only to confirm it and to send password reset codes, through the server's email provider. No newsletters.</li>
      <li><b>Notifications</b> pass through your browser's or phone's notification service (Apple, Google or Mozilla). Their contents are encrypted so that service can't read them.</li>
      <li><b>Link previews and GIF search</b> are fetched by the server itself, so the websites and the GIF service (KLIPY) see the server, not you. KLIPY does see the words you search for.</li>
      <li><b>Listen together</b> plays YouTube videos in YouTube's privacy-enhanced player, which loads from YouTube in your app, so YouTube sees your IP address while it plays.</li>
    </ul>

    <h2>How long it's kept</h2>
    <ul>
      <li>Your account and what you post stay until you delete them.</li>
      <li>Logins end after 30 days unused. Crash reports roll off after the newest 200.</li>
      ${backups}
    </ul>

    <h2>Your choices</h2>
    <ul>
      <li><b>Get a copy:</b> Your account › Your data › Download my data gives you a zip of your account, your messages and the files you sent.</li>
      <li><b>Fix or remove things:</b> edit or delete your messages, change your profile, or remove your email under Your account › Login and security at any time.</li>
      <li><b>Delete your account:</b> Your account › Your data › Delete my account. You choose whether your messages are deleted too or stay as "Deleted user". Your profile, email, friends, logins and passkeys are removed either way.</li>
      <li><b>Anything else</b>, including a question about your data, a correction, or a complaint: contact ${contactHtml(o.contact)}. If you're in the EU or UK you can also complain to your data protection authority.</li>
    </ul>

    <h2>Children</h2>
    <p>Peiskos is for people 13 and older. If you learn that someone under 13 has an account, contact ${contactHtml(o.contact)} and it will be deleted.</p>

    <h2>Changes</h2>
    <p>If this policy changes, the date at the top changes too. Big changes are announced in the app before they take effect.</p>
  `, o);
}

export function termsPage(o: LegalOptions) {
  const runBy = o.name ? esc(o.name) : 'the person who runs this server';
  return page('Terms of use', `
    <p>Peiskos is a small, friendly place, and these terms are here to keep it that way. By making an account you agree to them and to the <a href="/privacy">privacy policy</a>.</p>

    <h2>Who can use it</h2>
    <ul>
      <li>You must be 13 or older, and old enough where you live to agree to these terms on your own.</li>
      <li>One person per account. Keep your password to yourself; you're responsible for what happens on your account.</li>
    </ul>

    <h2>What's not allowed</h2>
    <p>There is no tolerance for objectionable content or abusive users. Don't post, share or do any of these:</p>
    <ul>
      <li>Harassment, bullying, threats, or hate aimed at people for who they are.</li>
      <li>Sexual content involving anyone under 18, of any kind. It is reported to the authorities.</li>
      <li>Sexual or graphic content shared with people who didn't choose to see it, or anyone's private pictures without their consent.</li>
      <li>Encouraging self-harm or violence.</li>
      <li>Other people's private information, posted without their permission.</li>
      <li>Anything illegal, including pirated material you don't have the right to share.</li>
      <li>Spam, scams, malware, or impersonating someone.</li>
      <li>Trying to break into accounts, overload the server, or get around a ban or block.</li>
    </ul>

    <h2>Keeping it safe</h2>
    <ul>
      <li>You can report a message, block a person, or leave a hearth at any time. Reports go to that hearth's moderators.</li>
      <li>Hosts and moderators can remove messages and people from their hearths. ${runBy} can remove anything, or suspend or delete any account, that breaks these terms, usually within 24 hours of a report.</li>
      <li>To report something to ${runBy} directly, contact ${contactHtml(o.contact)}.</li>
    </ul>

    <h2>Your content</h2>
    <p>What you post is yours. You give Peiskos permission to store it and show it to the people you shared it with, which is all it's used for. Only post things you have the right to share. If you believe something posted here infringes your copyright, contact ${contactHtml(o.contact)}.</p>

    <h2>No guarantees</h2>
    <p>Peiskos is run by a person, for friends, free of charge. It's provided as it is: it may go down, lose things, or change, and there's no promise it will always be available. Keep your own copies of anything important. As far as the law allows, ${runBy} isn't liable for losses from using it.</p>

    <h2>Leaving</h2>
    <p>You can delete your account whenever you want under Your account › Your data. An account that breaks these terms can be suspended or deleted.</p>

    <h2>Changes</h2>
    <p>If these terms change, the date at the top changes too, and big changes are announced in the app. Using Peiskos after a change means you accept the new terms.</p>
  `, o);
}
