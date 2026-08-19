import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const DOS_EPOCH_YEAR = 1980;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export function createZipFromDirectoryContents(sourceDirectory, zipPath) {
  const files = collectFiles(sourceDirectory);
  createZipFromFiles(files, zipPath);
}

export function readZipEntries(zipPath) {
  const buffer = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) {
    throw new Error(`Invalid ZIP file, missing central directory: ${zipPath}`);
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Invalid ZIP file, corrupt central directory entry at ${offset}: ${zipPath}`);
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    entries.push(buffer.toString("utf8", nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(zipPath, requestedName) {
  const buffer = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) {
    throw new Error(`Invalid ZIP file, missing central directory: ${zipPath}`);
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Invalid ZIP file, corrupt central directory entry at ${offset}: ${zipPath}`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const name = buffer.toString("utf8", nameStart, nameEnd);

    if (name === requestedName) {
      if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
        throw new Error(`Invalid ZIP local header for ${requestedName}: ${zipPath}`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === DEFLATE_METHOD) return inflateRawSync(compressed);
      if (compressionMethod === 0) return Buffer.from(compressed);
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${requestedName}`);
    }

    offset = nameEnd + extraLength + commentLength;
  }

  throw new Error(`ZIP entry not found: ${requestedName} in ${zipPath}`);
}

function createZipFromFiles(files, zipPath) {
  mkdirSync(path.dirname(zipPath), { recursive: true });
  if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true });
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.absolutePath);
    const compressed = deflateRawSync(data);
    const name = Buffer.from(file.archivePath, "utf8");
    const crc = crc32(data);
    const { dosTime, dosDate } = toDosDateTime(statSync(file.absolutePath).mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(zipPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function collectFiles(sourceDirectory) {
  const root = path.resolve(sourceDirectory);
  const files = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        absolutePath,
        archivePath: normalizeArchivePath(path.relative(root, absolutePath))
      });
    }
  }

  walk(root);
  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

function normalizeArchivePath(value) {
  return value.split(path.sep).join("/");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(DOS_EPOCH_YEAR, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosTime: (hours << 11) | (minutes << 5) | seconds,
    dosDate: ((year - DOS_EPOCH_YEAR) << 9) | (month << 5) | day
  };
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}
