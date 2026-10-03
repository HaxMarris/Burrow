import { createHmac } from 'node:crypto';

export interface VoiceOptions {
  apiKey: string;
  apiSecret: string;
  /** Public LiveKit address for clients. Unset means "same host as Burrow", with Caddy routing to LiveKit. */
  url?: string;
}

const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A LiveKit access token (HS256 JWT) that lets one user join one voice room. */
export function voiceToken(opts: VoiceOptions, user: { id: number; username: string }, room: string, ttlSeconds = 6 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    iss: opts.apiKey,
    sub: String(user.id),
    name: user.username,
    nbf: now - 10,
    exp: now + ttlSeconds,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
  });
  const sig = createHmac('sha256', opts.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
