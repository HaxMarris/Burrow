// Listen together: one YouTube video per fire, played in step for everyone there, with a queue
// of what's next. Like the fireside chat, it's only kept while someone is at the fire.
import type { Json } from './http.ts';

type Queued = { id: number; videoId: string; title: string; by: number };
type Listening = {
  videoId: string; title: string; playing: boolean; position: number; since: number; by: number;
  queue: Queued[]; skips: Set<number>; ended: boolean; startedAt: number;
};

const LISTEN_QUEUE_MAX = 50;

export interface ListenContext {
  /** Which fire (voice room) each person is at. */
  inVoice: Map<number, number>;
  usersInVoice: (channelId: number) => number[];
  sendTo: (userIds: Iterable<number>, event: Json) => void;
  /** Whoever manages voice in the hearth (hosts and mods) can skip or stop for everyone. */
  isBoss: (channelId: number, userId: number) => boolean;
  /** A video's name, for the queue (its player hasn't loaded it yet); undefined when it can't be found. */
  videoTitle: (videoId: string) => Promise<string | undefined>;
  /** They did something, so they aren't away. */
  active: (userId: number, t: number) => void;
  fail: (status: number, message: string) => Error;
}

export function listenTogether(ctx: ListenContext) {
  const { usersInVoice, sendTo } = ctx;
  const listening = new Map<number, Listening>(); // voice channel id -> what's playing
  let queuedId = 0;

  /** Votes it takes to skip: more than half of the people at the fire. */
  const skipsNeeded = (channelId: number) => Math.floor(usersInVoice(channelId).length / 2) + 1;
  const skipVotes = (channelId: number, l: Listening) => {
    const here = new Set(usersInVoice(channelId));
    return [...l.skips].filter((id) => here.has(id));
  };
  /** Where the video is now, in seconds, and the clock it was read at, so apps can line up. */
  const listenEvent = (channelId: number) => {
    const l = listening.get(channelId);
    const at = Date.now();
    return {
      type: 'listen_state',
      channelId,
      at,
      state: l
        ? {
            videoId: l.videoId,
            title: l.title,
            playing: l.playing,
            by: l.by,
            position: l.position + (l.playing ? (at - l.since) / 1000 : 0),
            ended: l.ended,
            queue: l.queue,
            skipVotes: skipVotes(channelId, l),
            skipsNeeded: skipsNeeded(channelId),
          }
        : null,
    };
  };
  const tellFire = (channelId: number) => sendTo(usersInVoice(channelId), listenEvent(channelId));

  /** Plays what's next in the queue, or stops at the end of this one when nothing is. */
  const playNext = (l: Listening, t: number) => {
    const next = l.queue.shift();
    l.skips.clear();
    if (next) Object.assign(l, { videoId: next.videoId, title: next.title, by: next.by, playing: true, position: 0, since: t, ended: false, startedAt: t });
    else Object.assign(l, { position: l.position + (l.playing ? (t - l.since) / 1000 : 0), since: t, playing: false, ended: true });
  };
  /** Looks up a video's name for the queue, since its player hasn't loaded it yet. */
  const nameQueued = (channelId: number, item: Queued) => {
    ctx
      .videoTitle(item.videoId)
      .then((title) => {
        const still = listening.get(channelId)?.queue.find((q) => q.id === item.id);
        if (!title || !still || still.title) return;
        still.title = title;
        tellFire(channelId);
      })
      .catch(() => {});
  };

  /** What someone at a fire asks for: start, queue, title, pause, play, seek, ended, skip, unqueue or stop. */
  const handle = (user: { id: number }, msg: Json) => {
    const channelId = ctx.inVoice.get(user.id);
    if (channelId === undefined) throw ctx.fail(400, 'Join a fire to listen together');
    const t = Date.now();
    const l = listening.get(channelId);
    const here = (l: Listening) => l.position + (l.playing ? (t - l.since) / 1000 : 0);
    const position = (value: unknown) => Math.max(0, Math.min(Number(value) || 0, 24 * 3600));
    if (msg.action === 'start' || msg.action === 'queue') {
      const videoId = typeof msg.videoId === 'string' && /^[\w-]{11}$/.test(msg.videoId) ? msg.videoId : null;
      if (!videoId) throw ctx.fail(400, "That isn't a YouTube video");
      if (!l) {
        listening.set(channelId, { videoId, title: '', playing: true, position: position(msg.position), since: t, by: user.id, queue: [], skips: new Set(), ended: false, startedAt: t });
      } else if (l.ended && !l.queue.length) {
        // The last one finished and nothing's next: this one plays now.
        Object.assign(l, { videoId, title: '', playing: true, position: position(msg.position), since: t, by: user.id, ended: false, startedAt: t });
        l.skips.clear();
      } else {
        // Something's already on: it goes to the back of the queue, rather than cutting in.
        if (l.queue.length >= LISTEN_QUEUE_MAX) throw ctx.fail(400, 'The queue is full');
        const item = { id: ++queuedId, videoId, title: '', by: user.id };
        l.queue.push(item);
        nameQueued(channelId, item);
      }
    } else if (!l) {
      return;
    } else if (msg.action === 'title') {
      // The app that started it says what it's called, once the video has loaded.
      if (l.title || typeof msg.title !== 'string') return;
      l.title = msg.title.trim().slice(0, 200);
    } else if (msg.action === 'pause' || msg.action === 'play') {
      Object.assign(l, { position: here(l), since: t, playing: msg.action === 'play', ended: false });
    } else if (msg.action === 'seek') {
      Object.assign(l, { position: position(msg.position), since: t, ended: false });
    } else if (msg.action === 'ended') {
      // On to what's next, or it stops at the end for everyone rather than starting over. Every
      // app says so when its player reaches the end, so only the first one counts: the others
      // name a video that's no longer on, or (older apps, which don't) arrive just after the next began.
      if (msg.videoId !== undefined && msg.videoId !== l.videoId) return;
      if (!l.playing || t - l.startedAt < 5000) return;
      playNext(l, t);
    } else if (msg.action === 'skip') {
      // Whoever put it on, and the hearth's hosts and mods, skip right away; anyone else votes,
      // and it's skipped once more than half the fire agrees. Voting again takes the vote back.
      if (msg.videoId !== undefined && msg.videoId !== l.videoId) return;
      if (l.by === user.id || ctx.isBoss(channelId, user.id)) playNext(l, t);
      else if (l.skips.has(user.id)) l.skips.delete(user.id);
      else {
        l.skips.add(user.id);
        if (skipVotes(channelId, l).length >= skipsNeeded(channelId)) playNext(l, t);
      }
    } else if (msg.action === 'unqueue') {
      // Taking something out of the queue: whoever added it, or a host or mod.
      const i = l.queue.findIndex((q) => q.id === Number(msg.id));
      if (i < 0) return;
      if (l.queue[i].by !== user.id && !ctx.isBoss(channelId, user.id)) throw ctx.fail(403, 'Only whoever added it can take it out');
      l.queue.splice(i, 1);
    } else if (msg.action === 'stop') {
      // Stopping ends the queue too, so it's for the same people who can skip right away.
      if (l.by !== user.id && !ctx.isBoss(channelId, user.id)) throw ctx.fail(403, 'Vote to skip instead');
      listening.delete(channelId);
    } else return;
    ctx.active(user.id, t);
    tellFire(channelId);
  };

  return {
    handle,
    /** Someone sat down at a fire: everyone there hears what's on (the skip count changed). */
    joined: (channelId: number) => {
      if (listening.has(channelId)) tellFire(channelId);
    },
    /**
     * Someone left a fire. The last one out stops whatever was playing; otherwise fewer people
     * means fewer votes to skip, which may now be enough.
     */
    left: (channelId: number) => {
      if (!usersInVoice(channelId).length) listening.delete(channelId);
      const l = listening.get(channelId);
      if (!l) return;
      if (l.skips.size && skipVotes(channelId, l).length >= skipsNeeded(channelId)) playNext(l, Date.now());
      tellFire(channelId);
    },
  };
}
