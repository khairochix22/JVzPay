/*
    MIT License

    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import helmet from "helmet";
import fs from "fs";
import os from "os";
import http from "http";
import https from "https";
import hbs from "hbs";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { env } from "./config/env.js";
import { checkConfig } from "./config/productionCheck.js";
import { checkEncryptionKey } from "./lib/keyCheck.js";
import * as healthCheck from "./controllers/system/healthController.js";
import { sequelize } from "./lib/db.js";
import router from "./routes/index.js";
import apiRouter from "./routes/api.js";
import { registerHelpers } from "./lib/hbsHelpers.js";
import { MysqlSessionStore } from "./middleware/sessionStore.js";
import { loadUser } from "./middleware/auth.js";
import { csrf } from "./middleware/csrf.js";
import { viewLocals } from "./middleware/locals.js";
import { dbMessage } from "./lib/errors.js";
import { startScheduler } from "./lib/scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Refuse to start with settings that are missing, weak or contradictory (config/productionCheck.js). In production
// that covers every required value; on a laptop only what would break signing in.
{
  const { errors, warnings } = checkConfig(process.env);
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  if (errors.length) {
    console.error(`❌ JVzPay will not start (NODE_ENV=${env.nodeEnv}). Fix these settings in .env, then restart:\n${errors.map((e) => `   - ${e}`).join("\n")}\n   Every setting is explained in .env.production.example and docs/DEPLOY-AWS.md.`);
    process.exit(1);
  }
}

const app = express();
const PORT = env.port;

app.disable("x-powered-by");
// Behind Nginx (TRUST_PROXY=1): req.ip, req.secure and req.protocol come from the X-Forwarded-For / X-Forwarded-Proto
// headers Nginx sets, so sign-in limits, audit logs and secure cookies see the real visitor. Off on a laptop.
if (env.trustProxy !== false) app.set("trust proxy", env.trustProxy);

// Public liveness check for monitoring: no database, no session, no data (GET /healthz also checks the database).
app.get("/health", healthCheck.alive);

// Security headers. Strict CSP: all scripts are same-origin files (no inline scripts, no CDN).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "upgrade-insecure-requests": env.cookieSecure || env.https.enabled ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/chartjs", express.static(path.join(__dirname, "node_modules", "chart.js", "dist")));

// keep the exact bytes of a JSON body: signed service requests are verified against them (lib/serviceSignature.js)
app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
// service-to-service API: signed requests or bearer tokens, no session or CSRF (docs/API_INTEGRATION.md).
// Served at both /api/v1 and the CRM integration contract's /api/integration/v1.
app.use(["/api/v1", "/api/integration/v1"], apiRouter);

app.use(
  session({
    name: "jvzpay.sid",
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // idle timeout: every request pushes expiry forward
    store: new MysqlSessionStore({ idleMs: env.sessionIdleMinutes * 60 * 1000 }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.cookieSecure || env.https.enabled, // COOKIE_SECURE=true on the server once https:// works
      maxAge: env.sessionIdleMinutes * 60 * 1000,
    },
  })
);
app.use(flash());

// A browser follows a redirect as soon as the headers arrive, which can be before the session reaches MySQL. Without this,
// the next page can load without the sign-in or the "saved" message that the redirecting request just stored.
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (!req.session) return redirect(...args);
    req.session.save((err) => (err ? next(err) : redirect(...args)));
  };
  next();
});

// Authenticated pages contain payroll data: never let the browser or a proxy cache them.
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use(loadUser);
app.use(csrf);

app.engine("xian", async (filePath, options, callback) => {
  try {
     const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});

app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  next();
});
app.use(viewLocals);

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");

// Register partials synchronously so the very first request already sees them.
registerHelpers();
const partialsDir = path.join(__dirname, "views/partials");
for (const file of fs.readdirSync(partialsDir).filter((f) => f.endsWith(".xian"))) {
  hbs.registerPartial(file.replace(".xian", ""), fs.readFileSync(path.join(partialsDir, file), "utf8"));
}

app.use("/", router);

// ---- 404 + error handling ----------------------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render("error", { title: "Page not found", code: 404, message: "The page you are looking for does not exist.", layoutBare: !req.user });
});

app.use((err, req, res, next) => {
  const dbMsg = dbMessage(err);
  const status = err.status || (dbMsg ? 409 : 500);
  if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  const message =
    status >= 500 ? "Something went wrong on our side. The incident has been logged." : (dbMsg || err.message);
  res.status(status).render("error", {
    title: status === 403 ? "Access denied" : "Error",
    code: status,
    message,
    layoutBare: !req.user,
  });
});

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = (port = PORT, host = env.host) => {
  return new Promise((resolve, reject) => {
    const tls = env.https.enabled ? { cert: fs.readFileSync(env.https.certFile), key: fs.readFileSync(env.https.keyFile) } : null;
    const server = tls ? https.createServer(tls, app) : http.createServer(app);
    server.listen(port, host, () => {
      const scheme = tls ? "https" : "http";
      console.log(`🔥 XianFire running at ${scheme}://${host || "localhost"}:${port}${env.publicBaseUrl ? `  (public address: ${env.publicBaseUrl})` : ""}`);
      // listening on every address (a laptop): show the ones the other JOHNVIVZ laptops on the same Wi-Fi can use
      const lan = host && !["0.0.0.0", "::"].includes(host) ? [] : Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => `${scheme}://${a.address}:${port}`);
      if (lan.length) console.log(`   On this network: ${lan.join("  ")}  (integration API: <address>/api/v1 or /api/integration/v1)`);
      if (tls && env.https.redirectPort) {
        http.createServer((req, res) => {
          res.writeHead(301, { Location: `https://${String(req.headers.host || "localhost").replace(/:\d+$/, "")}:${port}${req.url}` });
          res.end();
        }).listen(env.https.redirectPort);
      }
      startScheduler(); // audit sealing every minute; daily backup and retention clean-up
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Start whenever this file is loaded. Deliberately NO "main module" check (require.main === module or
// import.meta.url === process.argv[1]): under PM2 the main module is PM2's own ProcessContainerFork.js, so such a check
// is false, the app exits with code 0 and PM2 restarts it forever. Nothing imports index.js (the tests run
// `node index.js`). An Electron wrapper sets XIAN_ELECTRON to start the server itself.
if (!process.env.XIAN_ELECTRON) {
  try {
    // the key must open the bank and government ID numbers already in the database (lib/keyCheck.js)
    const key = await checkEncryptionKey();
    if (key.problem) {
      if (env.isProd) { console.error(`❌ JVzPay will not start: ${key.problem}`); process.exit(1); }
      console.warn(`⚠️  ${key.problem}`);
    }
  } catch (e) {
    console.warn(`⚠️  Could not check DATA_ENCRYPTION_KEY against the database (${e.message}). Is MySQL running?`);
  }
  const server = await startServer().catch((e) => {
    console.error(`❌ JVzPay could not listen on ${env.host || "every address"}:${PORT}: ${e.message}`);
    process.exit(1);
  });
  // PM2 (pm2 restart / reload / stop) and Ctrl+C: finish open requests, close the MySQL pool, then exit
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: stopping JVzPay…`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    server.close(() => sequelize.close().catch(() => {}).finally(() => process.exit(0)));
    server.closeIdleConnections?.();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
