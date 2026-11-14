// JohnVivz logo files for PDFs (payslips, report exports). Read once from public/img and kept in memory.
// A missing or unreadable file returns null, so a PDF still renders with its text heading instead of failing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = {
  full: "logo-full-print.png", // transparent full logo, 720 × 389, for white backgrounds
  mark: "logo-mark-print.png", // transparent icon only, 512 × 512
};
const cache = new Map();

export function brandImage(kind) {
  if (!cache.has(kind)) {
    let buf = null;
    try {
      if (FILES[kind]) buf = readFileSync(fileURLToPath(new URL(`../public/img/${FILES[kind]}`, import.meta.url)));
    } catch {
      buf = null;
    }
    cache.set(kind, buf);
  }
  return cache.get(kind);
}

/** Width/height ratio of the full logo, so callers can reserve space for it. */
export const FULL_LOGO_RATIO = 720 / 389;
