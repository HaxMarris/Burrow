// The fun extras: time at the fire and what it unlocks (something by your seat, and the look of a
// hearth's fire and the sky above it), toasting marshmallows, the message of the day and the year in review.
// Birthdays live with the rest of the profile in app.ts.
import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { Json } from './http.ts';

const HOUR = 3600_000;

/** What can sit by your seat at the fire, unlocked by your hours at fires. */
export const FIRE_ITEMS = [
  { id: 'cocoa', name: 'A mug of cocoa', emoji: '☕', hours: 1 },
  { id: 'marshmallow', name: 'Marshmallows', emoji: '🍡', hours: 2 },
  { id: 'mushroom', name: 'A forest mushroom', emoji: '🍄', hours: 5 },
  { id: 'guitar', name: 'A guitar', emoji: '🎸', hours: 10 },
  { id: 'hedgehog', name: 'A hedgehog', emoji: '🦔', hours: 20 },
  { id: 'fox', name: 'A fox', emoji: '🦊', hours: 35 },
  { id: 'owl', name: 'An owl', emoji: '🦉', hours: 50 },
  { id: 'deer', name: 'A deer', emoji: '🦌', hours: 75 },
  { id: 'bear', name: 'A bear', emoji: '🐻', hours: 100 },
  { id: 'wolf', name: 'A wolf', emoji: '🐺', hours: 150 },
];
/** How a hearth's fire looks, unlocked by everyone's hours at its fires together. */
export const FIRE_LOOKS = [
  { id: 'classic', name: 'Pine logs', hours: 0 },
  { id: 'birch', name: 'Birch logs', hours: 10 },
  { id: 'sparks', name: 'Sparks', hours: 25 },
  { id: 'blue', name: 'Blue flame', hours: 100 },
];
/** The sky above a hearth's fires, unlocked the same way. */
export const SKY_LOOKS = [
  { id: 'evening', name: 'Evening glow', hours: 0 },
  { id: 'stars', name: 'Starry night', hours: 5 },
  { id: 'moon', name: 'Full moon', hours: 15 },
  { id: 'aurora', name: 'Northern lights', hours: 50 },
  { id: 'meteors', name: 'Shooting stars', hours: 75 },
];
/** Toasting a marshmallow over the fire needs this much time at fires. */
export const MARSHMALLOW_HOURS = 2;
/**
 * Everything at the fire is unlocked from the start while Peiskos is being tested. Set
 * FIRE_UNLOCKS=hours to make things wait for hours at the fire again (hours are counted either way).
 */
const byHours = () => process.env.FIRE_UNLOCKS === 'hours';
const need = (hours: number) => (byHours() ? hours : 0);
const MARSHMALLOW_EVERY_MS = 15_000;
const MAX_MOTD = 30;
const MAX_MOTD_TEXT = 200;

/**
 * Keeps track of time spent at fires: a row per visit, whose end is kept up to date while
 * someone is still there, so a restart loses at most a minute of it.
 */
export function voiceTimeTracker(db: Db) {
  const open = new Map<number, number>(); // userId -> their voice_time row
  const stop = (userId: number) => {
    const id = open.get(userId);
    if (id === undefined) return;
    open.delete(userId);
    db.prepare('UPDATE voice_time SET ended_at = ? WHERE id = ?').run(Date.now(), id);
  };
  const start = (userId: number, serverId: number, channelId: number) => {
    stop(userId);
    const t = Date.now();
    const r = db.prepare('INSERT INTO voice_time (user_id, server_id, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(userId, serverId, channelId, t, t);
    open.set(userId, Number(r.lastInsertRowid));
  };
  setInterval(() => {
    const t = Date.now();
    for (const id of open.values()) db.prepare('UPDATE voice_time SET ended_at = ? WHERE id = ?').run(t, id);
  }, 60_000).unref();
  return { start, stop };
}

type User = { id: number; username: string };
type Channel = { id: number; serverId: number; kind: string; name: string; parentId?: number | null };
type Handler = (ctx: { user: User; params: string[]; body: Json }) => unknown;

export interface ExtrasContext {
  db: Db;
  route: (method: string, path: string, handler: Handler, auth?: boolean) => void;
  fail: (status: number, message: string) => Error;
  isMember: (serverId: number, userId: number) => boolean;
  allowed: (serverId: number, user: User, perm: 'burrow') => void;
  can: (serverId: number, userId: number, perm: 'burrow') => boolean;
  canSee: (channel: never, userId: number) => boolean;
  channelById: (id: number) => Channel | undefined;
  inVoice: Map<number, number>;
  sendServerUpdate: (serverId: number) => void;
  userChanged: (userId: number) => unknown;
  broadcastToChannel: (channel: never, event: Json) => void;
}

export function extras(ctx: ExtrasContext) {
  const { db, route, fail } = ctx;
  const now = () => Date.now();

  // ---- hours at the fire, and what they unlock

  // Time at a hearth's AFK fire doesn't count.
  const NOT_AFK = 'channel_id IS NOT (SELECT afk_channel_id FROM servers WHERE id = voice_time.server_id)';
  const sumHours = (where: string, ...args: (number | string)[]) =>
    (db.prepare(`SELECT COALESCE(SUM(ended_at - started_at), 0) AS ms FROM voice_time WHERE ${where} AND ${NOT_AFK}`).get(...args) as { ms: number }).ms / HOUR;
  const hoursOfUser = (userId: number) => sumHours('user_id = ?', userId);
  const hoursOfHearth = (serverId: number) => sumHours('server_id = ?', serverId);

  const myFire = (userId: number) => ({
    hours: hoursOfUser(userId),
    item: (db.prepare('SELECT fire_item FROM users WHERE id = ?').get(userId) as { fire_item: string | null } | undefined)?.fire_item ?? null,
    items: FIRE_ITEMS.map((i) => ({ ...i, hours: need(i.hours) })),
    marshmallowHours: need(MARSHMALLOW_HOURS),
  });
  route('GET', '/api/me/fire', ({ user }) => myFire(user.id));
  route('PUT', '/api/me/fire', ({ user, body }) => {
    const id = typeof body.item === 'string' ? body.item : null;
    if (id !== null) {
      const item = FIRE_ITEMS.find((i) => i.id === id);
      if (!item) throw fail(400, 'No such thing to bring');
      if (hoursOfUser(user.id) < need(item.hours)) throw fail(403, `That unlocks after ${item.hours} hours at the fire`);
    }
    db.prepare('UPDATE users SET fire_item = ? WHERE id = ?').run(id, user.id);
    ctx.userChanged(user.id);
    return myFire(user.id);
  });

  const hearthFire = (serverId: number, userId: number) => {
    const s = db.prepare('SELECT fire_look, sky_look FROM servers WHERE id = ?').get(serverId) as { fire_look: string | null; sky_look: string | null };
    return {
      hours: hoursOfHearth(serverId),
      look: s.fire_look ?? 'classic',
      looks: FIRE_LOOKS.map((l) => ({ ...l, hours: need(l.hours) })),
      sky: s.sky_look ?? 'evening',
      skies: SKY_LOOKS.map((l) => ({ ...l, hours: need(l.hours) })),
      canChange: ctx.can(serverId, userId, 'burrow'),
    };
  };
  const hearth = (serverId: number, userId: number) => {
    const s = db.prepare("SELECT kind FROM servers WHERE id = ?").get(serverId) as { kind: string } | undefined;
    if (!s || s.kind !== 'burrow' || !ctx.isMember(serverId, userId)) throw fail(404, 'Hearth not found');
  };
  route('GET', '/api/servers/:id/fire', ({ user, params }) => {
    const serverId = Number(params[0]);
    hearth(serverId, user.id);
    return hearthFire(serverId, user.id);
  });
  route('PUT', '/api/servers/:id/fire', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    hearth(serverId, user.id);
    ctx.allowed(serverId, user, 'burrow');
    // Either the fire ({ look }) or the sky above it ({ sky }).
    if (body.sky !== undefined) {
      const sky = SKY_LOOKS.find((l) => l.id === body.sky);
      if (!sky) throw fail(400, 'No such sky');
      if (hoursOfHearth(serverId) < need(sky.hours)) throw fail(403, `That sky unlocks after ${sky.hours} hours around this hearth's fires`);
      db.prepare('UPDATE servers SET sky_look = ? WHERE id = ?').run(sky.id === 'evening' ? null : sky.id, serverId);
    } else {
      const look = FIRE_LOOKS.find((l) => l.id === body.look);
      if (!look) throw fail(400, 'No such fire');
      if (hoursOfHearth(serverId) < need(look.hours)) throw fail(403, `That fire unlocks after ${look.hours} hours around this hearth's fires`);
      db.prepare('UPDATE servers SET fire_look = ? WHERE id = ?').run(look.id === 'classic' ? null : look.id, serverId);
    }
    ctx.sendServerUpdate(serverId);
    return hearthFire(serverId, user.id);
  });

  // Toasting a marshmallow: everyone at the fire sees how it turned out.
  const OUTCOMES: [string, number][] = [['golden', 45], ['perfect', 15], ['burnt', 25], ['dropped', 10], ['sticky', 5]];
  const lastToast = new Map<number, number>();
  route('POST', '/api/voice/marshmallow', ({ user }) => {
    const channelId = ctx.inVoice.get(user.id);
    const channel = channelId === undefined ? undefined : ctx.channelById(channelId);
    if (!channel) throw fail(400, 'Sit down at a fire first');
    if (hoursOfUser(user.id) < need(MARSHMALLOW_HOURS)) throw fail(403, `Marshmallows unlock after ${MARSHMALLOW_HOURS} hours at the fire`);
    if ((lastToast.get(user.id) ?? 0) > now() - MARSHMALLOW_EVERY_MS) throw fail(429, 'Let that one cool down first');
    lastToast.set(user.id, now());
    let roll = randomInt(100);
    const outcome = OUTCOMES.find(([, weight]) => (roll -= weight) < 0)![0];
    ctx.broadcastToChannel(channel as never, { type: 'marshmallow', channelId: channel.id, userId: user.id, outcome });
    return { outcome };
  });

  // ---- message of the day

  const motdOf = (serverId: number) =>
    (db.prepare('SELECT id, text, picture FROM motd WHERE server_id = ? ORDER BY id').all(serverId) as { id: number; text: string; picture: string | null }[]).map(
      (m) => ({ id: m.id, text: m.text, picture: m.picture ? `/api/burrow-pictures/${m.picture}` : null }),
    );
  const cleanMotd = (text: unknown) => {
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (t.length > MAX_MOTD_TEXT) throw fail(400, `Keep it to ${MAX_MOTD_TEXT} characters`);
    return t;
  };
  /** Checks a new line can be added; the picture upload calls this before and after saving its file. */
  const canAddMotd = (serverId: number, user: User) => {
    ctx.allowed(serverId, user, 'burrow');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM motd WHERE server_id = ?').get(serverId) as { n: number }).n;
    if (n >= MAX_MOTD) throw fail(400, `A hearth can have up to ${MAX_MOTD} messages of the day`);
  };
  const addMotd = (serverId: number, user: User, text: unknown, picture: string | null = null) => {
    canAddMotd(serverId, user);
    const t = cleanMotd(text);
    if (!t && !picture) throw fail(400, 'Write something, or add a photo');
    db.prepare('INSERT INTO motd (server_id, text, picture, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(serverId, t, picture, user.id, now());
    ctx.sendServerUpdate(serverId);
    return { motd: motdOf(serverId) };
  };
  route('POST', '/api/servers/:id/motd', ({ user, params, body }) => addMotd(Number(params[0]), user, body.text));
  const motdRow = (id: number, user: User) => {
    const m = db.prepare('SELECT server_id AS serverId, picture FROM motd WHERE id = ?').get(id) as { serverId: number; picture: string | null } | undefined;
    if (!m) throw fail(404, 'Already gone');
    ctx.allowed(m.serverId, user, 'burrow');
    return m;
  };
  route('PATCH', '/api/motd/:id', ({ user, params, body }) => {
    const id = Number(params[0]);
    const m = motdRow(id, user);
    const t = cleanMotd(body.text);
    if (!t && !m.picture) throw fail(400, 'Write something, or delete it');
    db.prepare('UPDATE motd SET text = ? WHERE id = ?').run(t, id);
    ctx.sendServerUpdate(m.serverId);
    return { motd: motdOf(m.serverId) };
  });
  // Its picture is left for the daily storage clean-up.
  route('DELETE', '/api/motd/:id', ({ user, params }) => {
    const id = Number(params[0]);
    const m = motdRow(id, user);
    db.prepare('DELETE FROM motd WHERE id = ?').run(id);
    ctx.sendServerUpdate(m.serverId);
    return { motd: motdOf(m.serverId) };
  });

  // ---- the year in review

  route('GET', '/api/servers/:id/review/:id', ({ user, params }) => {
    const [serverId, year] = params.map(Number);
    hearth(serverId, user.id);
    if (!(year >= 2000 && year <= 2100)) throw fail(400, 'Pick a year');
    const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
    // Only what this person can see: private rooms they're not in don't count.
    const channels = (db.prepare('SELECT id FROM channels WHERE server_id = ?').all(serverId) as { id: number }[])
      .map((c) => ctx.channelById(c.id)!)
      .filter((c) => c && ctx.canSee(c as never, user.id));
    const ids = channels.map((c) => c.id);
    const roomOf = new Map(channels.map((c) => [c.id, c.kind === 'thread' && c.parentId ? c.parentId : c.id]));
    const inList = ids.length ? ids.join(',') : 'NULL';
    const inYear = `m.channel_id IN (${inList}) AND m.created_at >= ${from} AND m.created_at < ${to}`;
    const nameOf = `COALESCE((SELECT nickname FROM members WHERE server_id = ${serverId} AND user_id = u.id), u.display_name, u.username)`;

    const messages = (db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${inYear}`).get() as { n: number }).n;
    const rooms = new Map<number, number>();
    for (const r of db.prepare(`SELECT m.channel_id AS id, COUNT(*) AS n FROM messages m WHERE ${inYear} GROUP BY m.channel_id`).all() as { id: number; n: number }[]) {
      const room = roomOf.get(r.id)!;
      rooms.set(room, (rooms.get(room) ?? 0) + r.n);
    }
    const topRooms = [...rooms]
      .map(([id, n]) => ({ id, name: ctx.channelById(id)?.name ?? '?', messages: n }))
      .filter((r) => ctx.channelById(r.id)?.kind !== 'voice')
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 5);
    const topReactions = db
      .prepare(`SELECT r.emoji, COUNT(*) AS n FROM reactions r JOIN messages m ON m.id = r.message_id WHERE ${inYear} GROUP BY r.emoji ORDER BY n DESC, MIN(r.created_at) LIMIT 8`)
      .all();
    const topPeople = db
      .prepare(`SELECT u.id, ${nameOf} AS name, COUNT(*) AS n FROM messages m JOIN users u ON u.id = m.author_id
                WHERE ${inYear} AND u.bot = 0 AND u.deleted_at IS NULL GROUP BY u.id ORDER BY n DESC LIMIT 5`)
      .all();
    const mostLoved = db
      .prepare(`SELECT m.id, m.channel_id AS channelId, substr(m.content, 1, 160) AS content, ${nameOf} AS author, COUNT(r.user_id) AS reactions
                FROM messages m JOIN reactions r ON r.message_id = m.id JOIN users u ON u.id = m.author_id
                WHERE ${inYear} AND m.content != '' GROUP BY m.id ORDER BY reactions DESC, m.id LIMIT 1`)
      .get() ?? null;
    const busiestDay = db
      .prepare(`SELECT date(m.created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM messages m WHERE ${inYear} GROUP BY day ORDER BY n DESC, day LIMIT 1`)
      .get() ?? null;
    const yearFire = `server_id = ${serverId} AND started_at >= ${from} AND started_at < ${to}`;
    const fireHours = sumHours(yearFire);
    const topFire = (db
      .prepare(`SELECT u.id, ${nameOf} AS name, SUM(v.ended_at - v.started_at) AS ms FROM voice_time v JOIN users u ON u.id = v.user_id
                WHERE v.server_id = ? AND v.started_at >= ? AND v.started_at < ?
                  AND v.channel_id IS NOT (SELECT afk_channel_id FROM servers WHERE id = v.server_id)
                GROUP BY u.id ORDER BY ms DESC LIMIT 3`)
      .all(serverId, from, to) as { id: number; name: string; ms: number }[]).map((p) => ({ id: p.id, name: p.name, hours: p.ms / HOUR }));
    const newPeople = (db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ? AND joined_at >= ? AND joined_at < ?').get(serverId, from, to) as { n: number }).n;
    const you = {
      messages: (db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${inYear} AND m.author_id = ?`).get(user.id) as { n: number }).n,
      reactions: (db.prepare(`SELECT COUNT(*) AS n FROM reactions r JOIN messages m ON m.id = r.message_id WHERE ${inYear} AND r.user_id = ?`).get(user.id) as { n: number }).n,
      fireHours: sumHours(`${yearFire} AND user_id = ?`, user.id),
    };
    const first = (db.prepare(`SELECT MIN(m.created_at) AS t FROM messages m WHERE m.channel_id IN (${inList})`).get() as { t: number | null }).t;
    const thisYear = new Date().getUTCFullYear();
    const years = [];
    for (let y = thisYear; y >= new Date(first ?? now()).getUTCFullYear(); y--) years.push(y);
    return { year, years, messages, topRooms, topReactions, topPeople, mostLoved, busiestDay, fireHours, topFire, newPeople, you };
  });

  return { motdOf, addMotd, canAddMotd };
}
