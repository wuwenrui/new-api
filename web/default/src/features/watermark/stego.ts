/**
 * 隐形数字指纹：把水印文字编码后嵌入图片亮度通道的 DCT 中频系数。
 * 肉眼不可见，但抗去水印工具、二次压缩与局部涂抹——可见文字被抹掉后，
 * 指纹仍可通过 extractInvisibleMark 投票恢复。
 *
 * 纯函数实现：只依赖 { data, width, height } 像素对象，可在 Node 中直接测试。
 */

export type PixelImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type ExtractResult = {
  found: boolean;
  text: string;
  /** 0-1，比特投票的平均一致度，越高越可信 */
  confidence: number;
};

const BLOCK = 8;
/** 嵌入用的中频系数对：行列互换的两个位置，差值承载 1 bit */
const COEF_A = 4 * BLOCK + 3; // (u=4, v=3)
const COEF_B = 3 * BLOCK + 4; // (u=3, v=4)
/** 系数差强度：越大越抗压缩，但可能产生可见噪点；32 在 JPEG 质量 70+ 下稳定 */
const DEFAULT_STRENGTH = 32;
/** 指纹文字最多编码 24 字节（UTF-8，约 8 个汉字） */
const MAX_PAYLOAD_BYTES = 24;

const SQRT_HALF = Math.SQRT1_2;

// 预计算 8 点 DCT 余弦表：COS[u][x] = cos((2x+1) * u * PI / 16)
const COS: number[][] = Array.from({ length: BLOCK }, (_, u) =>
  Array.from({ length: BLOCK }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)),
);
const C = Array.from({ length: BLOCK }, (_, u) => (u === 0 ? SQRT_HALF : 1));

function forwardDct8(input: Float64Array, output: Float64Array): void {
  for (let u = 0; u < BLOCK; u += 1) {
    const cosU = COS[u];
    let sum = 0;
    for (let x = 0; x < BLOCK; x += 1) sum += input[x] * cosU[x];
    output[u] = 0.5 * C[u] * sum;
  }
}

function inverseDct8(input: Float64Array, output: Float64Array): void {
  for (let x = 0; x < BLOCK; x += 1) {
    let sum = 0;
    for (let u = 0; u < BLOCK; u += 1) sum += C[u] * input[u] * COS[u][x];
    output[x] = 0.5 * sum;
  }
}

function forwardDctBlock(block: Float64Array): void {
  const temp = new Float64Array(BLOCK * BLOCK);
  const inLine = new Float64Array(BLOCK);
  const outLine = new Float64Array(BLOCK);
  for (let y = 0; y < BLOCK; y += 1) {
    for (let x = 0; x < BLOCK; x += 1) inLine[x] = block[y * BLOCK + x];
    forwardDct8(inLine, outLine);
    for (let u = 0; u < BLOCK; u += 1) temp[y * BLOCK + u] = outLine[u];
  }
  for (let u = 0; u < BLOCK; u += 1) {
    for (let y = 0; y < BLOCK; y += 1) inLine[y] = temp[y * BLOCK + u];
    forwardDct8(inLine, outLine);
    for (let v = 0; v < BLOCK; v += 1) block[v * BLOCK + u] = outLine[v];
  }
}

function inverseDctBlock(block: Float64Array): void {
  const temp = new Float64Array(BLOCK * BLOCK);
  const inLine = new Float64Array(BLOCK);
  const outLine = new Float64Array(BLOCK);
  for (let v = 0; v < BLOCK; v += 1) {
    for (let u = 0; u < BLOCK; u += 1) inLine[u] = block[v * BLOCK + u];
    inverseDct8(inLine, outLine);
    for (let x = 0; x < BLOCK; x += 1) temp[v * BLOCK + x] = outLine[x];
  }
  for (let x = 0; x < BLOCK; x += 1) {
    for (let v = 0; v < BLOCK; v += 1) inLine[v] = temp[v * BLOCK + x];
    inverseDct8(inLine, outLine);
    for (let y = 0; y < BLOCK; y += 1) block[y * BLOCK + x] = outLine[y];
  }
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** 文字 → [长度, ...UTF-8 字节, CRC16 高, CRC16 低] 的比特数组（MSB 优先） */
export function textToBits(text: string): number[] {
  const raw = new TextEncoder().encode(text.trim()).slice(0, MAX_PAYLOAD_BYTES);
  if (raw.length === 0) return [];
  const body = new Uint8Array(1 + raw.length);
  body[0] = raw.length;
  body.set(raw, 1);
  const crc = crc16(body);
  const payload = new Uint8Array(body.length + 2);
  payload.set(body, 0);
  payload[body.length] = crc >> 8;
  payload[body.length + 1] = crc & 0xff;
  const bits: number[] = [];
  for (const byte of payload) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }
  return bits;
}

function bitsToText(bits: number[]): string | null {
  if (bits.length < 8 || bits.length % 8 !== 0) return null;
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i * 8 + j];
    bytes[i] = byte;
  }
  const length = bytes[0];
  if (length < 1 || length > MAX_PAYLOAD_BYTES || bytes.length !== length + 3) return null;
  const body = bytes.slice(0, 1 + length);
  const expected = (bytes[1 + length] << 8) | bytes[2 + length];
  if (crc16(body) !== expected) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(1, 1 + length));
}

function readLuminanceBlock(image: PixelImage, bx: number, by: number, out: Float64Array): void {
  const originX = bx * BLOCK;
  const originY = by * BLOCK;
  for (let y = 0; y < BLOCK; y += 1) {
    for (let x = 0; x < BLOCK; x += 1) {
      const offset = ((originY + y) * image.width + originX + x) * 4;
      out[y * BLOCK + x] =
        0.299 * image.data[offset] +
        0.587 * image.data[offset + 1] +
        0.114 * image.data[offset + 2] -
        128;
    }
  }
}

function applyLuminanceDelta(image: PixelImage, bx: number, by: number, delta: Float64Array): void {
  const originX = bx * BLOCK;
  const originY = by * BLOCK;
  for (let y = 0; y < BLOCK; y += 1) {
    for (let x = 0; x < BLOCK; x += 1) {
      const d = delta[y * BLOCK + x];
      if (d === 0) continue;
      const offset = ((originY + y) * image.width + originX + x) * 4;
      image.data[offset] = image.data[offset] + d;
      image.data[offset + 1] = image.data[offset + 1] + d;
      image.data[offset + 2] = image.data[offset + 2] + d;
    }
  }
}

/**
 * 把文字指纹嵌入图片像素（原地修改）。
 * 返回 false 表示图片太小，容纳不下这条指纹。
 */
export function embedInvisibleMark(
  image: PixelImage,
  text: string,
  strength: number = DEFAULT_STRENGTH,
): boolean {
  const bits = textToBits(text);
  if (bits.length === 0) return false;
  const cols = Math.floor(image.width / BLOCK);
  const rows = Math.floor(image.height / BLOCK);
  if (cols * rows < bits.length) return false;

  const block = new Float64Array(BLOCK * BLOCK);
  let index = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      const bit = bits[index % bits.length];
      index += 1;
      readLuminanceBlock(image, bx, by, block);
      const original = Float64Array.from(block);
      forwardDctBlock(block);
      const a = block[COEF_A];
      const b = block[COEF_B];
      const diff = a - b;
      const satisfied = bit === 1 ? diff >= strength : diff <= -strength;
      if (!satisfied) {
        const mid = (a + b) / 2;
        const wanted = bit === 1 ? strength : -strength;
        block[COEF_A] = mid + wanted / 2;
        block[COEF_B] = mid - wanted / 2;
        inverseDctBlock(block);
        for (let i = 0; i < block.length; i += 1) block[i] -= original[i];
        applyLuminanceDelta(image, bx, by, block);
      }
    }
  }
  return true;
}

/** 从图片像素中盲检测指纹文字 */
export function extractInvisibleMark(image: PixelImage): ExtractResult {
  const cols = Math.floor(image.width / BLOCK);
  const rows = Math.floor(image.height / BLOCK);
  const total = cols * rows;
  const none: ExtractResult = { found: false, text: "", confidence: 0 };
  if (total === 0) return none;

  // 先取每个 8x8 块的系数差，再按各候选载荷长度投票，取 CRC 通过且一致度最高者
  const blockDiffs = new Float64Array(total);
  const block = new Float64Array(BLOCK * BLOCK);
  let index = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      readLuminanceBlock(image, bx, by, block);
      forwardDctBlock(block);
      blockDiffs[index] = block[COEF_A] - block[COEF_B];
      index += 1;
    }
  }

  let best: ExtractResult = none;
  for (let payloadBytes = 1; payloadBytes <= MAX_PAYLOAD_BYTES; payloadBytes += 1) {
    const bitCount = (payloadBytes + 3) * 8;
    if (total < bitCount) break;
    const votes = new Float64Array(bitCount);
    for (let i = 0; i < total; i += 1) {
      votes[i % bitCount] += blockDiffs[i];
    }
    const bits: number[] = [];
    let agree = 0;
    const repeats = Math.floor(total / bitCount);
    for (let i = 0; i < bitCount; i += 1) {
      bits.push(votes[i] > 0 ? 1 : 0);
      agree += Math.min(1, Math.abs(votes[i]) / (repeats * DEFAULT_STRENGTH));
    }
    const text = bitsToText(bits);
    if (text === null) continue;
    const confidence = agree / bitCount;
    if (confidence > best.confidence) {
      best = { found: true, text, confidence };
    }
  }
  return best;
}

/** 指纹文字超过编码上限时按 UTF-8 字符边界截断；空文字回退到 fallback */
export function fingerprintTextFor(text: string, fallback: string): string {
  const trimmed = text.trim();
  const candidate = trimmed.length > 0 ? trimmed : fallback;
  if (new TextEncoder().encode(candidate).length <= MAX_PAYLOAD_BYTES) return candidate;
  let result = "";
  for (const char of candidate) {
    if (new TextEncoder().encode(result + char).length > MAX_PAYLOAD_BYTES) break;
    result += char;
  }
  return result;
}

export const INVISIBLE_MARK_MAX_BYTES = MAX_PAYLOAD_BYTES;
