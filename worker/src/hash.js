const encoder = new TextEncoder();

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function sha256Hex(text) {
  return [...await sha256Bytes(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares digests, not the strings, so neither length nor content leaks through timing. */
export async function timingSafeEqualText(a, b) {
  const [left, right] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
