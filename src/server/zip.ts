import type { FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  file: FileHandle;
  size: number;
}

const FLAGS = 0x0808; // UTF-8 filenames and an end-of-file data descriptor.

export async function* streamStoreZip(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const centralDirectory: Buffer[] = [];
  const names = new Set<string>();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;

  for (const entry of entries) {
    const sanitized = entry.name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || 'image';
    const dot = sanitized.lastIndexOf('.');
    const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
    const extension = dot > 0 ? sanitized.slice(dot) : '';
    let filename = sanitized;
    for (let suffix = 1; names.has(filename.toLowerCase()); suffix++) {
      filename = `${stem} (${suffix})${extension}`;
    }
    names.add(filename.toLowerCase());
    const name = Buffer.from(filename, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;

    let checksum = 0;
    let size = 0;
    if (entry.size > 0) {
      for await (const chunk of entry.file.createReadStream({ end: entry.size - 1, autoClose: false })) {
        const bytes = chunk as Buffer;
        checksum = crc32(bytes, checksum);
        size += bytes.length;
        yield bytes;
      }
      if (size !== entry.size) throw new Error('File size changed during download');
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralDirectory.push(central, name);
    offset += local.length + name.length + size + descriptor.length;
  }

  let directorySize = 0;
  for (const chunk of centralDirectory) {
    yield chunk;
    directorySize += chunk.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}

