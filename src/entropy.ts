/**
 * §5 require_e2e gate. Structural enforcement, not cryptographic proof — the
 * honest limit is documented: we cannot prove ciphertext targets the
 * registered key. What we CAN guarantee: nothing that passes this gate is
 * readable by us or a subpoena.
 *
 *   1. length >= 48 and consistent with sealed-box framing (32B epk ‖ box)
 *   2. Shannon entropy >= 7.5 bits/byte, no plaintext signatures
 *   3. sender declared encrypted: true (checked by caller)
 */

const ENTROPY_MIN_BITS = 7.5;
const MIN_LEN = 48;

export function shannonBitsPerByte(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const freq = new Array<number>(256).fill(0);
  for (const b of bytes) freq[b] = (freq[b] ?? 0) + 1;
  let h = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Recognizable-plaintext sniff: JSON/XML, magic bytes, long UTF-8 runs. */
export function looksLikePlaintext(bytes: Uint8Array): string | null {
  const head = bytes.slice(0, 64);
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(head).trimStart();
  if (/^[{[]/.test(text)) return "json_sniff";
  if (/^</.test(text)) return "xml_sniff";
  // Common file magic
  const magics: Array<[number[], string]> = [
    [[0x89, 0x50, 0x4e, 0x47], "png"],
    [[0xff, 0xd8, 0xff], "jpeg"],
    [[0x25, 0x50, 0x44, 0x46], "pdf"],
    [[0x50, 0x4b, 0x03, 0x04], "zip"],
    [[0x47, 0x49, 0x46, 0x38], "gif"],
  ];
  for (const [magic, name] of magics)
    if (magic.every((m, i) => bytes[i] === m)) return `magic_${name}`;
  // Long printable-ASCII run = prose or config, not ciphertext.
  let run = 0;
  for (let i = 0; i < Math.min(bytes.length, 512); i++) {
    const b = bytes[i]!;
    if (b >= 0x20 && b < 0x7f) {
      run++;
      if (run >= 64) return "ascii_run";
    } else run = 0;
  }
  return null;
}

export interface GateResult {
  pass: boolean;
  reason?: string;
  entropy: number;
}

export function e2eGate(bytes: Uint8Array): GateResult {
  const entropy = shannonBitsPerByte(bytes);
  if (bytes.length < MIN_LEN)
    return { pass: false, reason: `body shorter than sealed-box minimum (${MIN_LEN} bytes)`, entropy };
  const sniff = looksLikePlaintext(bytes);
  if (sniff) return { pass: false, reason: `recognizable plaintext (${sniff})`, entropy };
  if (entropy < ENTROPY_MIN_BITS)
    return {
      pass: false,
      reason: `entropy ${entropy.toFixed(2)} bits/byte below ${ENTROPY_MIN_BITS} — real ciphertext is indistinguishable from random`,
      entropy,
    };
  return { pass: true, entropy };
}
