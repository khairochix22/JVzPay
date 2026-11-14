// Outgoing email. Works only when SMTP is configured in .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM);
// otherwise mailConfigured() is false and callers fall back to a manual step (e.g. Payroll Staff activate accounts).
// nodemailer is loaded only when needed, so the app runs without it until email is set up.
export const mailConfigured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

let transport;
async function getTransport() {
  if (transport) return transport;
  const nodemailer = (await import("nodemailer")).default;
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  return transport;
}

/** Send a plain-text email. Throws when sending fails so the caller can tell the person. */
export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) throw new Error("Email is not configured.");
  const t = await getTransport();
  await t.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}
