// The look of the emails Peiskos sends: a short branded card with the code front and center,
// plus a plain-text copy for mail apps that don't show HTML. Inline styles and tables only,
// because that's all email apps reliably understand.

export type CodeEmail = {
  /** Who it's for, shown as "Hi name,". */
  username: string;
  /** One line above the code, like "Here's your code to reset your Peiskos password." */
  intro: string;
  code: string;
  minutes: number;
  /** A line under the code, like "If it wasn't you, ignore this email." */
  note: string;
  /** Where Peiskos is, for the logo and the "Open Peiskos" button. */
  publicUrl?: string;
  /** Where people can write back, shown in the footer. */
  contact?: string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The Glød colors (client/style.css).
const EMBER = '#c4561c';
const OAT = '#f6f0e7';
const CHAR = '#1f1813';
const MUTED = '#6f6259';
const CARD = '#fffdf9';
const LINE = '#eadfd0';

export function codeEmail(m: CodeEmail): { text: string; html: string } {
  const base = m.publicUrl?.replace(/\/$/, '');
  const text = [
    `Hi ${m.username},`,
    '',
    m.intro,
    '',
    `    ${m.code}`,
    '',
    `It works for ${m.minutes} minutes.`,
    ...(base ? ['', `Open Peiskos: ${base}`] : []),
    '',
    m.note,
    '',
    '-- ',
    'Peiskos',
    ...(m.contact ? [`Questions? Write to ${m.contact}`] : []),
  ].join('\n');

  const font = `'Nunito Sans', 'Segoe UI', Helvetica, Arial, sans-serif`;
  const serif = `Fraunces, Georgia, 'Times New Roman', serif`;
  const logo = base
    ? `<img src="${esc(base)}/icon-192.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px">`
    : '';
  const button = base
    ? `<tr><td align="center" style="padding:8px 32px 28px">
        <a href="${esc(base)}" style="display:inline-block;background:${EMBER};color:#ffffff;font-family:${font};font-size:15px;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:999px">Open Peiskos</a>
      </td></tr>`
    : '';
  const contact = m.contact
    ? `Questions? Write to <a href="mailto:${esc(m.contact)}" style="color:${EMBER};text-decoration:none">${esc(m.contact)}</a><br>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Peiskos</title></head>
<body style="margin:0;padding:0;background:${OAT}">
<div style="display:none;max-height:0;overflow:hidden">Your code is ${esc(m.code)}. It works for ${m.minutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${OAT}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
      <tr><td style="padding:0 4px 18px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          ${logo ? `<td style="padding-right:10px">${logo}</td>` : ''}
          <td style="font-family:${serif};font-size:22px;font-weight:600;color:${CHAR}">Peiskos</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${CARD};border:1px solid ${LINE};border-radius:16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:28px 32px 4px;font-family:${font};font-size:16px;line-height:1.5;color:${CHAR}">
            Hi ${esc(m.username)},<br><br>${esc(m.intro)}
          </td></tr>
          <tr><td align="center" style="padding:20px 32px">
            <div style="display:inline-block;background:${OAT};border:1px solid ${LINE};border-radius:12px;padding:14px 24px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:${CHAR}">${esc(m.code)}</div>
            <div style="padding-top:10px;font-family:${font};font-size:13px;color:${MUTED}">It works for ${m.minutes} minutes.</div>
          </td></tr>
          ${button}
          <tr><td style="padding:0 32px 28px;font-family:${font};font-size:14px;line-height:1.5;color:${MUTED}">${esc(m.note)}</td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:18px 16px 0;font-family:${font};font-size:12px;line-height:1.6;color:${MUTED}">
        ${contact}This email was sent automatically by Peiskos${base ? ` (<a href="${esc(base)}" style="color:${MUTED}">${esc(new URL(base).host)}</a>)` : ''}.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { text, html };
}
