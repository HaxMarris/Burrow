// Web Push: alerts on phones and in browsers while Burrow isn't open.
//
// The browser gives each device an address at its push service (Google's, Mozilla's, Apple's)
// and two keys. A message is encrypted for that device (RFC 8291, "aes128gcm") so the push
// service can't read it, and signed with this server's own key (VAPID, RFC 8292) so only this
// server can send to the addresses it was given. Nothing here needs an account anywhere.
import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, generateKeyPairSync } from 'node:crypto';

export type PushSubscription = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateJwk: string };

const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');

/** A new key pair for signing pushes, kept by the server for good. */
export function newVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // The browser wants the raw public point: 0x04, then x and y.
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: b64u(raw), privateJwk: JSON.stringify(privateKey.export({ format: 'jwk' })) };
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
};

/** The message, encrypted so only that one device can read it. */
export function encryptPayload(sub: PushSubscription, payload: Buffer) {
  const salt = randomBytes(16);
  const ecdh = createECDH('prime256v1');
  const ours = ecdh.generateKeys();
  const theirs = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  const shared = ecdh.computeSecret(theirs);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), theirs, ours]), 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // One record: the message, then 0x02 to say it's the last.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(ours.length, 20);
  return Buffer.concat([header, ours, body]);
}

/** "This push really comes from this server", good for 12 hours, for one push service. */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: JSON.parse(keys.privateJwk), format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Sends one push. Resolves to 'sent', 'gone' (the device unsubscribed: forget it) or 'failed'.
 * Pushes wait at the push service for up to a day if the device is off.
 */
export async function sendPush(sub: PushSubscription, message: unknown, keys: VapidKeys, subject: string, urgency: 'high' | 'normal' = 'high') {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(sub.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 3600),
        urgency,
      },
      body: encryptPayload(sub, Buffer.from(JSON.stringify(message))),
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => {});
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Whether the public key from newVapidKeys matches its private half (a damaged setting is replaced). */
export function vapidKeysWork(keys: VapidKeys) {
  try {
    const jwk = createPublicKey({ key: JSON.parse(keys.privateJwk), format: 'jwk' }).export({ format: 'jwk' });
    return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])) === keys.publicKey;
  } catch {
    return false;
  }
}
