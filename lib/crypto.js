import crypto from "crypto";
import { env } from "../config/env.js";

// AES-256-GCM. Stored format:  v1:<iv b64>:<tag b64>:<ciphertext b64>
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", env.dataKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(blob) {
  if (!blob) return null;
  const [ver, iv, tag, data] = String(blob).split(":");
  if (ver !== "v1") throw new Error("Unsupported ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", env.dataKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// "1234567890" -> "••••••7890". Never returns the full number.
export function maskNumber(plain, visible = 4) {
  if (!plain) return "";
  const s = String(plain).replace(/\s+/g, "");
  return "•".repeat(Math.max(s.length - visible, 4)) + s.slice(-visible);
}

export const maskEncrypted = (blob, visible = 4) => {
  try { return maskNumber(decrypt(blob), visible); } catch { return "••••"; }
};
