/**
 * A minimal, dependency-free ZIP writer — enough to package the addon the same way on every
 * platform, without shelling out to `zip` (absent on Windows, and finicky about argument order) or
 * PowerShell's Compress-Archive (which writes backslash paths some tools reject).
 *
 * Standard ZIP: a local header + DEFLATE body per entry, a central directory, and the end record.
 * Names use forward slashes (the spec's requirement) so the archive reads correctly everywhere,
 * including WoW's own extractor. Good for small archives — no ZIP64, no streaming.
 *
 *   writeZip('out.zip', [{ name: 'Addon/' }, { name: 'Addon/file.lua', data: Buffer }]);
 *
 * A name ending in '/' is a directory entry (no data). Everything else is DEFLATE-compressed.
 */
import { deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS timestamp (2020-01-01 00:00) so the archive is byte-for-byte reproducible from the
// same inputs — the checksum beside it then means something.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * @param {string} outPath
 * @param {Array<{ name: string, data?: Buffer }>} entries
 */
export function writeZip(outPath, entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.name.endsWith('/');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = isDir ? Buffer.alloc(0) : entry.data ?? Buffer.alloc(0);
    const method = isDir || raw.length === 0 ? 0 : 8; // store empty/dir, deflate the rest
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = isDir ? 0 : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attributes (MS-DOS directory bit)
    cd.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central directory size
  end.writeUInt32LE(offset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length

  writeFileSync(outPath, Buffer.concat([...parts, centralBuf, end]));
}
