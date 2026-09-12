// 流式 SHA-256（纯 JS，无依赖）。
//
// 为什么不直接用 WebCrypto？因为局域网通常用 http://192.168.x.x 访问，
// 那是"非安全上下文"，crypto.subtle 直接不可用（见 DESIGN.md §6）。
// 实现按 FIPS 180-4，对照测试见 tests/js/sha256.test.js（与 node:crypto 逐字节比对）。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK = 64;

export class Sha256 {
  #h = new Uint32Array(8);
  #w = new Uint32Array(64);
  #buffer = new Uint8Array(BLOCK);
  #bufferLength = 0;
  #bytesHashed = 0;
  #finalized = false;

  constructor() {
    this.reset();
  }

  reset() {
    this.#h.set(INIT);
    this.#bufferLength = 0;
    this.#bytesHashed = 0;
    this.#finalized = false;
    return this;
  }

  /** 已喂入的字节数（用于进度显示）。 */
  get bytesHashed() {
    return this.#bytesHashed;
  }

  /** 增量喂数据：string（UTF-8）/ Uint8Array / ArrayBuffer / TypedArray / DataView。 */
  update(data) {
    if (this.#finalized) {
      throw new Error('Sha256 已完成计算，请 reset() 后重用');
    }
    const bytes = toBytes(data);
    this.#bytesHashed += bytes.length;

    let offset = 0;
    if (this.#bufferLength > 0) {
      const take = Math.min(BLOCK - this.#bufferLength, bytes.length);
      this.#buffer.set(bytes.subarray(0, take), this.#bufferLength);
      this.#bufferLength += take;
      offset = take;
      if (this.#bufferLength === BLOCK) {
        this.#compress(this.#buffer, 0);
        this.#bufferLength = 0;
      }
    }

    while (bytes.length - offset >= BLOCK) {
      this.#compress(bytes, offset);
      offset += BLOCK;
    }

    if (offset < bytes.length) {
      this.#buffer.set(bytes.subarray(offset), 0);
      this.#bufferLength = bytes.length - offset;
    }
    return this;
  }

  /** 返回 32 字节摘要（大端）。可重复调用。 */
  digest() {
    if (!this.#finalized) {
      this.#finalize();
    }
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      view.setUint32(i * 4, this.#h[i], false);
    }
    return out;
  }

  /** 返回小写十六进制摘要。 */
  hex() {
    return toHex(this.digest());
  }

  #finalize() {
    this.#finalized = true;
    const bits = BigInt(this.#bytesHashed) * 8n;
    const hi = Number((bits >> 32n) & 0xffffffffn);
    const lo = Number(bits & 0xffffffffn);

    const padded = new Uint8Array(this.#bufferLength < BLOCK - 8 ? BLOCK : BLOCK * 2);
    padded.set(this.#buffer.subarray(0, this.#bufferLength));
    padded[this.#bufferLength] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, hi, false);
    view.setUint32(padded.length - 4, lo, false);

    for (let i = 0; i < padded.length; i += BLOCK) {
      this.#compress(padded, i);
    }
  }

  #compress(bytes, offset) {
    const w = this.#w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
      const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    const h = this.#h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 =
        (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 =
        (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
}

/** 一次性算摘要，返回小写十六进制。 */
export function sha256Hex(data) {
  return new Sha256().update(data).hex();
}

export function toHex(bytes) {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function toBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('Sha256.update 只接受 string / Uint8Array / ArrayBuffer / TypedArray');
}
