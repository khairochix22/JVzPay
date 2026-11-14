/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
import { Sequelize } from "sequelize";
import { env } from "../config/env.js";

// Connection settings now come from .env (see .env.example). Session timezone is Philippine Standard Time so
// CURRENT_TIMESTAMP defaults and JS Date round-trips agree.
export const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: "mysql",
  timezone: "+08:00",
  logging: false,
  pool: { max: 10, min: 0, idle: 10000 },
});
