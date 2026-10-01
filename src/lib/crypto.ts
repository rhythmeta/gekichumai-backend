import { Buffer } from "node:buffer";

const encoder = new TextEncoder();

export const sha256Hex = async (value: string): Promise<string> => {
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Buffer.from(buffer).toString("hex");
};

export const randomToken = (bytes = 48): string => {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
};
