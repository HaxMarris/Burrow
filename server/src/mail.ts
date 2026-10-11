// Sending email: just enough SMTP to hand a short plain-text message to a mail server you
// already have (your email provider, Amazon SES, Mailgun, a Gmail app password...).
//
// SMTP_URL picks it: smtps://user:password@host:465 for a server that starts encrypted, or
// smtp://user:password@host:587 for one that switches to encryption after saying hello
// (STARTTLS). Burrow refuses to send a password over a connection that isn't encrypted,
// except to the same computer (for testing).
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';

export type MailConfig = { url: string; from: string; rejectUnauthorized?: boolean };
export type Mail = { to: string; subject: string; text: string };

/** A rough check that an address could receive mail; the real check is the code sent there. */
export const looksLikeEmail = (s: string) => s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s);

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** Reads SMTP replies (a three-digit code, maybe over several lines). */
function replies(sock: Socket | TLSSocket) {
  let buf = '';
  let waiting: ((r: { code: number; text: string }) => void) | null = null;
  let failed: ((e: Error) => void) | null = null;
  const ready: { code: number; text: string }[] = [];
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    let m: RegExpExecArray | null;
    // A reply ends with a line whose code is followed by a space.
    while ((m = /^((?:\d{3}-[^\r\n]*\r?\n)*)(\d{3})(?: [^\r\n]*)?\r?\n/.exec(buf))) {
      const reply = { code: Number(m[2]), text: m[0] };
      buf = buf.slice(m[0].length);
      if (waiting) { const w = waiting; waiting = null; failed = null; w(reply); } else ready.push(reply);
    }
  };
  sock.on('data', onData);
  const onError = (e: Error) => { if (failed) { const f = failed; failed = null; waiting = null; f(e); } };
  sock.on('error', onError);
  sock.on('close', () => onError(new Error('The mail server hung up')));
  return {
    next: () =>
      new Promise<{ code: number; text: string }>((resolve, reject) => {
        const r = ready.shift();
        if (r) return resolve(r);
        waiting = resolve;
        failed = reject;
      }),
    detach: () => { sock.off('data', onData); sock.off('error', onError); },
  };
}

/** Sends one email. Throws with the server's own words if it says no. */
export async function sendMail(config: MailConfig, mail: Mail) {
  const url = new URL(config.url);
  const secure = url.protocol === 'smtps:';
  const host = url.hostname;
  const port = Number(url.port) || (secure ? 465 : 587);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const tlsOpts = { servername: host, rejectUnauthorized: config.rejectUnauthorized ?? true };

  let sock: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const s = secure ? tlsConnect({ host, port, ...tlsOpts }, () => resolve(s)) : tcpConnect({ host, port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(20_000, () => s.destroy(new Error('The mail server took too long')));
  });
  let r = replies(sock);
  const expect = async (ok: number[]) => {
    const reply = await r.next();
    if (!ok.includes(reply.code)) throw new Error(`Mail server said: ${reply.text.trim().split(/\r?\n/).pop()}`);
    return reply;
  };
  const say = (line: string, ok: number[]) => { sock.write(line + '\r\n'); return expect(ok); };
  try {
    await expect([220]);
    let hello = await say('EHLO burrow', [250]);
    if (!secure && /STARTTLS/i.test(hello.text)) {
      await say('STARTTLS', [220]);
      r.detach();
      sock = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ socket: sock as Socket, ...tlsOpts }, () => resolve(s));
        s.once('error', reject);
      });
      r = replies(sock);
      hello = await say('EHLO burrow', [250]);
    } else if (!secure && user && !local) {
      throw new Error("The mail server doesn't offer encryption, so Burrow won't send it your password");
    }
    if (user) await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
    const from = /<([^>]+)>/.exec(config.from)?.[1] ?? config.from;
    await say(`MAIL FROM:<${from}>`, [250]);
    await say(`RCPT TO:<${mail.to}>`, [250, 251]);
    await say('DATA', [354]);
    const domain = from.split('@')[1] ?? 'burrow';
    const body = Buffer.from(mail.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
    const message = [
      `From: ${config.from}`,
      `To: <${mail.to}>`,
      `Subject: ${encodeWord(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
      '',
      body,
    ].join('\r\n');
    sock.write(message + '\r\n.\r\n');
    await expect([250]);
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}
