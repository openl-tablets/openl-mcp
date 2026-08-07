/** Shared helpers for transporting text and binary file content over MCP. */

/** Detect binary data using NUL/control-byte sampling. */
export function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  if (sampleLength === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) suspicious += 1;
  }
  return suspicious / sampleLength > 0.1;
}

/** Validate base64 strictly because Buffer.from silently ignores bad input. */
export function isValidBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  if (compact.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return false;
  return Buffer.from(compact, "base64").toString("base64") === compact;
}
