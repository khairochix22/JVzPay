import "dotenv/config";

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. Run "npm run setup" to generate .env.`);
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || "JVzPay",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
  },
  get sessionSecret() { return required("SESSION_SECRET"); },
  // 32-byte key (64 hex chars) for AES-256-GCM encryption of bank and government ID numbers
  get dataKey() {
    const k = required("DATA_ENCRYPTION_KEY");
    if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    return Buffer.from(k, "hex");
  },
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 30),
  maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS || 3),
  resetLinkMinutes: Number(process.env.RESET_LINK_MINUTES || 30),
  // HTTPS: set both files (PEM) to serve TLS directly; behind a TLS proxy in production, leave them empty
  https: {
    enabled: Boolean(process.env.HTTPS_CERT_FILE && process.env.HTTPS_KEY_FILE),
    certFile: process.env.HTTPS_CERT_FILE || "",
    keyFile: process.env.HTTPS_KEY_FILE || "",
    redirectPort: Number(process.env.HTTP_REDIRECT_PORT || 0),
  },
  lockoutMinutes: Number(process.env.LOCKOUT_MINUTES || 15),
  company: {
    name: process.env.COMPANY_NAME || "JohnVivz Grocery Store",
    address: process.env.COMPANY_ADDRESS || "Bongabong, Oriental Mindoro, Philippines",
  },
};
