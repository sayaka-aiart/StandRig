import { PNG } from "pngjs";
import type { RgbaImage } from "./png.js";

export const MAX_DECODED_TEXTURE_BYTES = 1024 * 1024 * 1024;

/** Decode source textures for both admission and software rendering. */
export function decodeTexturePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 33 || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii",12,16) !== "IHDR") throw new Error("Missing PNG image header");
  const pixels = buffer.readUInt32BE(16) * buffer.readUInt32BE(20);
  if (!pixels || pixels > MAX_DECODED_TEXTURE_BYTES / 4) throw new Error("PNG dimensions exceed the decoded texture limit");
  const { width, height, data } = PNG.sync.read(buffer, { checkCRC: true });
  if (data.byteLength !== pixels * 4) throw new Error("Invalid PNG image dimensions");
  return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}
