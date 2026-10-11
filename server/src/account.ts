// Account security helpers: two-step login codes (TOTP), passkeys (WebAuthn) and the
// zip file "Export my data" downloads. Plain Node, no extra packages.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { crc32 } from 'node:zlib';

// ---- two-step login: RFC 6238 time-based codes ------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

/** The 6-digit code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const totpStep = (t = Date.now()) => Math.floor(t / 30_000);

/**
 * The step a code belongs to, allowing one step either side for a slow phone clock,
 * or null when it's wrong. Steps at or before `after` were already used.
 */
export function checkTotp(secret: string, code: string, after = -1, t = Date.now()): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = totpStep(t);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= after) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(clean))) return step;
  }
  return null;
}

/** Ten one-time codes for when the phone is lost, like "k3f9-2mqx". */
export function newRecoveryCodes(): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const hashRecovery = (code: string) => createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

// ---- passkeys: just enough CBOR and WebAuthn to check a signature -------------

type Cbor = number | bigint | string | Buffer | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** Reads one CBOR item; returns it and where the next one starts. */
export function decodeCbor(buf: Buffer, pos = 0): [Cbor, number] {
  if (pos >= buf.length) throw new Error('CBOR ends early');
  const first = buf[pos++];
  const major = first >> 5;
  const info = first & 31;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) len = buf.readUInt8(pos), (pos += 1);
  else if (info === 25) len = buf.readUInt16BE(pos), (pos += 2);
  else if (info === 26) len = buf.readUInt32BE(pos), (pos += 4);
  else if (info === 27) len = Number(buf.readBigUInt64BE(pos)), (pos += 8);
  else throw new Error('Unsupported CBOR');
  switch (major) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2:
    case 3: {
      if (pos + len > buf.length) throw new Error('CBOR ends early');
      const bytes = buf.subarray(pos, pos + len);
      return [major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), pos + len];
    }
    case 4: {
      const list: Cbor[] = [];
      for (let i = 0; i < len; i++) {
        const [v, next] = decodeCbor(buf, pos);
        list.push(v);
        pos = next;
      }
      return [list, pos];
    }
    case 5: {
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < len; i++) {
        const [k, a] = decodeCbor(buf, pos);
        const [v, b] = decodeCbor(buf, a);
        map.set(k, v);
        pos = b;
      }
      return [map, pos];
    }
    case 6: return decodeCbor(buf, pos); // a tag: the item it wraps
    default:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22) return [null, pos];
      throw new Error('Unsupported CBOR');
  }
}

/** Writes CBOR; tests use it to play the part of a phone or security key. */
export function encodeCbor(v: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  return Buffer.from([0xf6]);
}

const b64u = (b: Buffer) => b.toString('base64url');

/** A COSE public key from an authenticator, as a JWK Node can verify with. */
export function coseToJwk(cose: Map<Cbor, Cbor>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1), alg = Number(cose.get(3));
  const bytes = (k: number) => {
    const b = cose.get(k);
    if (!Buffer.isBuffer(b)) throw new Error('Bad key');
    return b64u(b);
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) }, alg };
  if (kty === 3 && alg === -257) return { jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) }, alg };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) }, alg };
  throw new Error("This passkey uses a kind of key Peiskos doesn't know");
}

export type AuthData = { rpIdHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; publicKey?: Map<Cbor, Cbor> };

/** The authenticator's data: which site, whether a person was there, its counter and maybe a new key. */
export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new Error('Authenticator data is too short');
  const out: AuthData = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & 0x40) {
    const idLen = buf.readUInt16BE(53);
    out.credentialId = buf.subarray(55, 55 + idLen);
    const [key] = decodeCbor(buf, 55 + idLen);
    if (!(key instanceof Map)) throw new Error('Bad key');
    out.publicKey = key;
  }
  return out;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** Checks clientDataJSON: the right ceremony, our challenge, and a page on our site. */
export function checkClientData(raw: Buffer, type: string, challenge: string, rpId: string) {
  let data: { type?: string; challenge?: string; origin?: string };
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error("The passkey's answer couldn't be read"); }
  if (data.type !== type) throw new Error('Wrong kind of passkey answer');
  if (data.challenge !== challenge) throw new Error('That passkey request ran out. Try again.');
  let host = '';
  try { host = new URL(String(data.origin)).hostname; } catch { /* checked below */ }
  if (host !== rpId) throw new Error('That passkey answer came from another site');
}

/** Checks a new passkey from navigator.credentials.create() and returns what to keep. */
export function verifyRegistration(cred: { clientDataJSON: string; attestationObject: string }, challenge: string, rpId: string) {
  checkClientData(Buffer.from(cred.clientDataJSON, 'base64url'), 'webauthn.create', challenge, rpId);
  const [att] = decodeCbor(Buffer.from(cred.attestationObject, 'base64url'));
  const authData = att instanceof Map ? att.get('authData') : null;
  if (!Buffer.isBuffer(authData)) throw new Error("The passkey's answer couldn't be read");
  const a = parseAuthData(authData);
  if (!a.rpIdHash.equals(sha256(rpId))) throw new Error('That passkey is for another site');
  if (!(a.flags & 0x01)) throw new Error('Nobody was there to approve the passkey');
  if (!a.credentialId || !a.publicKey) throw new Error('The passkey sent no key');
  const { jwk, alg } = coseToJwk(a.publicKey);
  createPublicKey({ key: jwk, format: 'jwk' }); // throws on a broken key
  return { id: b64u(a.credentialId), jwk, alg, signCount: a.signCount };
}

/** Checks a passkey login from navigator.credentials.get() against the key we kept. */
export function verifyAssertion(
  cred: { clientDataJSON: string; authenticatorData: string; signature: string },
  key: { jwk: JsonWebKey; alg: number; signCount: number },
  challenge: string,
  rpId: string,
) {
  const clientData = Buffer.from(cred.clientDataJSON, 'base64url');
  checkClientData(clientData, 'webauthn.get', challenge, rpId);
  const authData = Buffer.from(cred.authenticatorData, 'base64url');
  const a = parseAuthData(authData);
  if (!a.rpIdHash.equals(sha256(rpId))) throw new Error('That passkey is for another site');
  if (!(a.flags & 0x01)) throw new Error('Nobody was there to approve the passkey');
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const publicKey = createPublicKey({ key: key.jwk, format: 'jwk' });
  const ok = verify(key.alg === -8 ? null : 'sha256', signed, publicKey, Buffer.from(cred.signature, 'base64url'));
  if (!ok) throw new Error("That passkey didn't check out");
  // A counter that goes backwards means a copied key. Many passkeys always send 0.
  if ((a.signCount || key.signCount) && a.signCount <= key.signCount) throw new Error('That passkey looks copied. Remove it and add it again.');
  return { signCount: a.signCount };
}

// ---- zip (stored, no compression: photos and videos don't shrink anyway) -------

/** Builds a zip one file at a time: add() and finish() hand back the bytes to send next. */
export class ZipWriter {
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;

  add(name: string, data: Buffer, time = new Date()): Buffer[] {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | Math.floor(time.getSeconds() / 2);
    const dosDate = ((Math.max(1980, time.getFullYear()) - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(this.offset, 42);
    this.central.push(entry, nameBuf);
    this.offset += local.length + nameBuf.length + data.length;
    this.count++;
    return [local, nameBuf, data];
  }

  finish(): Buffer {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([dir, end]);
  }
}
