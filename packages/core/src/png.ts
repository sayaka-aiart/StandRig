import { deflate, inflate } from "pako";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(input: Uint8Array): RgbaImage {
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (input[index] !== PNG_SIGNATURE[index]) {
      throw new Error("Unsupported image: PNG signature was not found.");
    }
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset < input.length) {
    const length = readUint32(input, offset);
    offset += 4;
    const type = readAscii(input, offset, 4);
    offset += 4;
    const data = input.subarray(offset, offset + length);
    offset += length + 4;

    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0) {
    throw new Error("Unsupported image: PNG dimensions are missing.");
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported image: PNG bit depth ${bitDepth} is not supported yet.`);
  }
  if (interlace !== 0) {
    throw new Error("Unsupported image: interlaced PNG is not supported yet.");
  }

  const channels = channelsForColorType(colorType);
  const rowBytes = width * channels;
  const inflated = inflate(concatBytes(idatChunks));
  const rgba = new Uint8ClampedArray(width * height * 4);
  let sourceOffset = 0;
  let previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = new Uint8Array(rowBytes);

    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset];
      sourceOffset += 1;
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= channels ? previous[x - channels] ?? 0 : 0;

      row[x] = unfilterByte(filter, raw, left, up, upperLeft);
    }

    writeRgbaRow(rgba, row, y, width, colorType, channels);
    previous = row;
  }

  return { width, height, data: rgba };
}

export function encodePng(image: RgbaImage): Uint8Array {
  const scanlineLength = image.width * 4 + 1;
  const scanlines = new Uint8Array(scanlineLength * image.height);

  for (let y = 0; y < image.height; y += 1) {
    const lineOffset = y * scanlineLength;
    scanlines[lineOffset] = 0;
    scanlines.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), lineOffset + 1);
  }

  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, image.width);
  writeUint32(ihdr, 4, image.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflate(scanlines)),
    pngChunk("IEND", new Uint8Array())
  ]);
}

export function createBlankRgba(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = fill[0];
    data[offset + 1] = fill[1];
    data[offset + 2] = fill[2];
    data[offset + 3] = fill[3];
  }
  return { width, height, data };
}

function channelsForColorType(colorType: number): number {
  if (colorType === 0) {
    return 1;
  }
  if (colorType === 2) {
    return 3;
  }
  if (colorType === 4) {
    return 2;
  }
  if (colorType === 6) {
    return 4;
  }
  throw new Error(`Unsupported image: PNG color type ${colorType} is not supported yet.`);
}

function unfilterByte(filter: number, raw: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) {
    return raw;
  }
  if (filter === 1) {
    return (raw + left) & 255;
  }
  if (filter === 2) {
    return (raw + up) & 255;
  }
  if (filter === 3) {
    return (raw + Math.floor((left + up) / 2)) & 255;
  }
  if (filter === 4) {
    return (raw + paeth(left, up, upperLeft)) & 255;
  }
  throw new Error(`Unsupported image: PNG filter ${filter} is not supported.`);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (upDistance <= upperLeftDistance) {
    return up;
  }
  return upperLeft;
}

function writeRgbaRow(
  rgba: Uint8ClampedArray,
  row: Uint8Array,
  y: number,
  width: number,
  colorType: number,
  channels: number
) {
  for (let x = 0; x < width; x += 1) {
    const source = x * channels;
    const target = (y * width + x) * 4;

    if (colorType === 0) {
      const gray = row[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = 255;
    } else if (colorType === 2) {
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      const gray = row[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = row[source + 1];
    } else {
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = row[source + 3];
    }
  }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(bytes[offset + index]);
  }
  return result;
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const table = crcTable ?? makeCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}
