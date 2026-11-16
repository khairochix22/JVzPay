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
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

import { env } from "./config/env.js";
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

const app = express();
const PORT = env.port;

app.disable("x-powered-by");
if (env.isProd) app.set("trust proxy", 1); // behind nginx/Apache: needed for secure cookies and real client IPs

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
        "upgrade-insecure-requests": env.isProd ? [] : null,
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
      secure: env.isProd || env.https.enabled,
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
export const startServer = (port = PORT) => {
  return new Promise((resolve, reject) => {
    const tls = env.https.enabled ? { cert: fs.readFileSync(env.https.certFile), key: fs.readFileSync(env.https.keyFile) } : null;
    const server = tls ? https.createServer(tls, app) : http.createServer(app);
    server.listen(port, () => {
      const scheme = tls ? "https" : "http";
      console.log(`🔥 XianFire running at ${scheme}://localhost:${port}`);
      // it listens on every address: show the ones the other JOHNVIVZ laptops on the same Wi-Fi can use
      const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => `${scheme}://${a.address}:${port}`);
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

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
