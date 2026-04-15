/**
 * nuggets-memory-pro — HRR Core Engine
 *
 * Holographic Reduced Representation (HRR) for associative memory.
 * Based on Plate (1995) and the original NeoVertex1/nuggets implementation.
 *
 * Key operations:
 *   bind(a, b)   → circular convolution  (association)
 *   probe(m, a)  → circular correlation  (retrieval)
 *   superpose()  → vector addition + normalisation (memory accumulation)
 *
 * All vectors live in R^DIM and are L2-normalised before storage.
 * FFT-based operations keep binding O(n log n).
 */

export const HRR_DIM = 512; // fixed-width representation

// ─── complex number helpers ───────────────────────────────────────────────────

type Complex = { re: number; im: number };

function complexMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function complexConj(a: Complex): Complex {
  return { re: a.re, im: -a.im };
}

// ─── Cooley–Tukey FFT (in-place, radix-2) ────────────────────────────────────

function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (invert ? -1 : 1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1,
        curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

/** Generate a random unit vector of length DIM */
export function randomVector(dim: number = HRR_DIM): Float64Array {
  const v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return normalise(v);
}

/** L2-normalise in-place; returns the same array */
export function normalise(v: Float64Array): Float64Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

/** Dot product of two vectors */
export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine similarity (vectors are assumed normalised) */
export function cosine(a: Float64Array, b: Float64Array): number {
  return dot(a, b); // already L2-normalised
}

// ─── HRR core operations ──────────────────────────────────────────────────────

/**
 * Bind two vectors via circular convolution.
 * bind(a, b) ≈ inverse-probe(b, bind(a,b))
 */
export function bind(a: Float64Array, b: Float64Array): Float64Array {
  const n = a.length;
  const reA = new Float64Array(a);
  const imA = new Float64Array(n);
  const reB = new Float64Array(b);
  const imB = new Float64Array(n);

  fft(reA, imA, false);
  fft(reB, imB, false);

  const reC = new Float64Array(n);
  const imC = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = complexMul({ re: reA[i], im: imA[i] }, { re: reB[i], im: imB[i] });
    reC[i] = c.re;
    imC[i] = c.im;
  }

  fft(reC, imC, true); // inverse FFT
  return normalise(reC);
}

/**
 * Probe memory with a cue: retrieves the approximate binding partner.
 * probe(memory, cue) ≈ value  when memory = bind(cue, value)
 * Implemented as circular correlation (conjugate in freq domain).
 */
export function probe(memory: Float64Array, cue: Float64Array): Float64Array {
  const n = memory.length;
  const reMem = new Float64Array(memory);
  const imMem = new Float64Array(n);
  const reCue = new Float64Array(cue);
  const imCue = new Float64Array(n);

  fft(reMem, imMem, false);
  fft(reCue, imCue, false);

  const reR = new Float64Array(n);
  const imR = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // multiply by conjugate of cue
    const c = complexMul(
      { re: reMem[i], im: imMem[i] },
      complexConj({ re: reCue[i], im: imCue[i] })
    );
    reR[i] = c.re;
    imR[i] = c.im;
  }

  fft(reR, imR, true);
  return normalise(reR);
}

/**
 * Superpose multiple vectors (elementwise addition + normalise).
 * Accumulates associations without binding loss.
 */
export function superpose(...vectors: Float64Array[]): Float64Array {
  const n = vectors[0].length;
  const result = new Float64Array(n);
  for (const v of vectors) {
    for (let i = 0; i < n; i++) result[i] += v[i];
  }
  return normalise(result);
}

// ─── Token → vector mapping (deterministic, seeded) ─────────────────────────

/**
 * Deterministically map a string token to a unit vector.
 * Uses a seeded PRNG so the same token always produces the same vector.
 * Compatible with the original nuggets token-role encoding.
 */
export function tokenVector(token: string, dim: number = HRR_DIM): Float64Array {
  // Derive seed from token using DJB2-style hash
  let seed = 5381;
  for (let i = 0; i < token.length; i++) {
    seed = (seed * 33) ^ token.charCodeAt(i);
    seed = seed >>> 0; // keep 32-bit unsigned
  }

  const v = new Float64Array(dim);
  // Seeded LCG (Knuth): X_{n+1} = (X_n * 1664525 + 1013904223) mod 2^32
  let x = seed;
  for (let i = 0; i < dim; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    v[i] = (x / 0xffffffff) * 2 - 1; // ∈ (-1, 1)
  }
  return normalise(v);
}

// ─── State anchor (HRR determinism guardrail) ────────────────────────────────

/**
 * Compute a compact state fingerprint from a memory vector.
 * Used as an anchor hash to detect memory drift between agent turns.
 */
export function stateAnchor(memory: Float64Array): string {
  // Project onto 16 probe directions and quantise to 4 bits each → 8-byte hex
  const projections: number[] = [];
  for (let i = 0; i < 16; i++) {
    const probe_vec = tokenVector(`__anchor_probe_${i}__`);
    projections.push(dot(memory, probe_vec));
  }
  // Quantise each into 4 bits (0–15)
  const bytes: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    const hi = Math.min(15, Math.floor((projections[i] + 1) * 7.5));
    const lo = Math.min(15, Math.floor((projections[i + 1] + 1) * 7.5));
    bytes.push((hi << 4) | lo);
  }
  return Buffer.from(bytes).toString('hex');
}

// ─── Serialisation ───────────────────────────────────────────────────────────

export function serialiseVector(v: Float64Array): number[] {
  return Array.from(v);
}

export function deserialiseVector(arr: number[]): Float64Array {
  return new Float64Array(arr);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HRRMemorySlot {
  id: string;
  label: string;
  vector: Float64Array;
  anchor: string;
  createdAt: number;
  updatedAt: number;
  priority: number; // 0 = normal, 1 = high, 2 = critical
  tags: string[];
}

export interface HRRQueryResult {
  slot: HRRMemorySlot;
  similarity: number;
}
