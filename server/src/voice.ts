import { createHmac } from 'node:crypto';

export interface VoiceOptions {
  apiKey: string;
  apiSecret: string;
  /** Public LiveKit address for clients. Unset means "same host as Burrow", with Caddy routing to LiveKit. */
  url?: string;
  /** Where Burrow itself reaches LiveKit's API, to take people out of rooms. */
  apiUrl?: string;
}

const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function sign(opts: VoiceOptions, claims: Record<string, unknown>, ttlSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ iss: opts.apiKey, nbf: now - 10, exp: now + ttlSeconds, ...claims });
  const sig = createHmac('sha256', opts.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** What someone may send: everything, or (muted for everyone by a moderator) everything but their microphone. */
const sources = (canSpeak: boolean) => [...(canSpeak ? ['microphone'] : []), 'camera', 'screen_share', 'screen_share_audio'];

/**
 * A LiveKit access token (HS256 JWT) that lets one user join one voice room, with their mic, camera and screen.
 * It's only for joining (the app asks for a fresh one each time, and LiveKit renews it while they're in), so it
 * runs out soon: someone removed from a hearth can't use one they kept to sit back down.
 */
export function voiceToken(opts: VoiceOptions, user: { id: number; username: string }, room: string, ttlSeconds = 15 * 60, canSpeak = true) {
  return sign(
    opts,
    {
      sub: String(user.id),
      name: user.username,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: sources(canSpeak) },
    },
    ttlSeconds,
  );
}

async function roomService(opts: VoiceOptions, method: string, room: string, body: Record<string, unknown>) {
  const token = sign(opts, { video: { room, roomAdmin: true, roomCreate: true } }, 60);
  const res = await fetch(`${(opts.apiUrl ?? 'http://localhost:7880').replace(/\/$/, '')}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ room, ...body }),
    signal: AbortSignal.timeout(5000),
  });
  // Someone who isn't in the room, or a room nobody is in, is already what we wanted.
  if (!res.ok && res.status !== 404) throw new Error(`LiveKit said ${res.status} to ${method}`);
}

/** Disconnects someone from a voice room right away, for when they're removed or lose access. */
export const removeFromRoom = (opts: VoiceOptions, room: string, identity: string) =>
  roomService(opts, 'RemoveParticipant', room, { identity });

/** Disconnects everyone from a voice room, for when the room or its burrow is deleted. */
export const closeRoom = (opts: VoiceOptions, room: string) => roomService(opts, 'DeleteRoom', room, {});

/** Lets someone already in a room speak again, or stops their microphone being sent at all. */
export const setCanSpeak = (opts: VoiceOptions, room: string, identity: string, canSpeak: boolean) =>
  roomService(opts, 'UpdateParticipant', room, {
    identity,
    permission: { canSubscribe: true, canPublish: true, canPublishData: true, canPublishSources: sources(canSpeak).map((s) => s.toUpperCase()) },
  });
