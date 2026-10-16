// Games at the fire: one game per fire, played by up to four of the people sitting there. Whoever
// starts it runs the game in their app; Peiskos only passes messages between the players (who's
// moving where, and the board as the host's app sees it), so nothing goes peer to peer. Like the
// fireside chat it's only kept in memory, and it ends when its host leaves.
import { WebSocket } from 'ws';
import type { Json } from './http.ts';

export const GAMES = ['melonbomber'] as const;
type GameName = (typeof GAMES)[number];
type Game = { name: GameName; hostId: number; players: Map<number, WebSocket>; since: number };

const MAX_PLAYERS = 4;
const MAX_MESSAGE = 16 * 1024; // one message's game data, as JSON

export interface GamesContext {
  /** Which fire (voice room) each person is at. */
  inVoice: Map<number, number>;
  usersInVoice: (channelId: number) => number[];
  sendTo: (userIds: Iterable<number>, event: Json) => void;
  fail: (status: number, message: string) => Error;
}

export function fireGames(ctx: GamesContext) {
  const { usersInVoice, sendTo } = ctx;
  const games = new Map<number, Game>(); // voice channel id -> the game there

  const gameEvent = (channelId: number) => {
    const g = games.get(channelId);
    return { type: 'game_state', channelId, game: g ? { name: g.name, hostId: g.hostId, players: [...g.players.keys()], since: g.since } : null };
  };
  const tellFire = (channelId: number) => sendTo(usersInVoice(channelId), gameEvent(channelId));

  /** Takes someone out of the game at a fire. When it's the host, the game is over for everyone. */
  const drop = (channelId: number, userId: number) => {
    const g = games.get(channelId);
    if (!g?.players.has(userId)) return;
    if (g.hostId === userId) games.delete(channelId);
    else g.players.delete(userId);
    tellFire(channelId);
  };

  /** What someone at a fire asks for: start (or join) a game, leave it, or pass a message on in it. */
  const handle = (user: { id: number }, ws: WebSocket, msg: Json) => {
    const channelId = ctx.inVoice.get(user.id);
    if (channelId === undefined) throw ctx.fail(400, 'Join a fire to play');
    const g = games.get(channelId);
    if (msg.action === 'send') {
      // Only from the device they play on, to the host or (from the host) to the others.
      if (!g || g.players.get(user.id) !== ws) return;
      const data = msg.data;
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > MAX_MESSAGE) return;
      const to = user.id === g.hostId ? (msg.to === 'all' ? [...g.players.keys()].filter((id) => id !== user.id) : [Number(msg.to)]) : [g.hostId];
      const out = JSON.stringify({ type: 'game_msg', channelId, from: user.id, data });
      for (const id of to) {
        const socket = g.players.get(id);
        if (id !== user.id && socket?.readyState === WebSocket.OPEN) socket.send(out);
      }
      return;
    }
    if (msg.action === 'start') {
      const name = GAMES.find((n) => n === msg.game);
      if (!name) throw ctx.fail(400, "That game isn't here");
      if (!g) {
        games.set(channelId, { name, hostId: user.id, players: new Map([[user.id, ws]]), since: Date.now() });
      } else if (g.players.has(user.id)) {
        g.players.set(user.id, ws); // playing from this device now
      } else {
        if (g.name !== name) throw ctx.fail(409, 'Another game is going at this fire');
        if (g.players.size >= MAX_PLAYERS) throw ctx.fail(409, `The game is full (${MAX_PLAYERS} players)`);
        g.players.set(user.id, ws);
      }
    } else if (msg.action === 'leave') {
      return drop(channelId, user.id);
    } else return;
    tellFire(channelId);
  };

  return {
    handle,
    /** Someone sat down at a fire: they see the game going there, if there is one. */
    joined: (channelId: number, userId: number) => {
      if (games.has(channelId)) sendTo([userId], gameEvent(channelId));
    },
    /** Someone left a fire, so they're out of its game. */
    left: (channelId: number, userId: number) => drop(channelId, userId),
    /** A connection closed: if it was the one they played on, they're out of the game. */
    closed: (userId: number, ws: WebSocket) => {
      for (const [channelId, g] of games) if (g.players.get(userId) === ws) drop(channelId, userId);
    },
  };
}
