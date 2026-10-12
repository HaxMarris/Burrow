// What kinds of files Peiskos keeps, recognised by their first bytes rather than by what the app says they are.

export type FileKind = { ext: string; type: string; magic: (b: Buffer) => boolean };

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
// Profile and burrow pictures are recognised by their first bytes, not by what the client says they are.
export const AVATAR_TYPES: FileKind[] = [
  { ext: 'png', type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { ext: 'jpg', type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
// Soundboard clips, also recognised by their first bytes.
export const MAX_SOUND_BYTES = 1024 * 1024;
export const SOUND_TYPES: FileKind[] = [
  { ext: 'mp3', type: 'audio/mpeg', magic: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: 'ogg', type: 'audio/ogg', magic: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { ext: 'wav', type: 'audio/wav', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  { ext: 'webm', type: 'audio/webm', magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { ext: 'm4a', type: 'audio/mp4', magic: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
];

// Shown in the page. Everything else downloads, so an uploaded .html or .svg can't run as part of Burrow.
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac',
]);
