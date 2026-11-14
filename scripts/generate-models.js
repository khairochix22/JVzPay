// Generates one Sequelize model file per database table (models/<name>Model.js) plus models/index.js with every
// association, straight from the LIVE schema in information_schema. Run after every new migration:
//     npm run models:generate
// The SQL migrations stay the source of truth for the schema (triggers/CHECKs cannot be expressed in models), so these
// models are never used with sequelize.sync(). tests/models.test.js fails if a model drifts from its table.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { select, sequelize } from "../lib/db.js";
import { env } from "../config/env.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "models");
const schema = env.db.name;

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());
const IRREGULAR = { user_sessions: "user_session", schema_migrations: "schema_migration", role_permissions: "role_permission", sequences: "sequence" };
function singular(table) {
  if (IRREGULAR[table]) return IRREGULAR[table];
  const parts = table.split("_");
  const last = parts.pop();
  let s = last;
  if (/ies$/.test(last)) s = last.replace(/ies$/, "y");
  else if (/(ses|xes|ches|shes)$/.test(last)) s = last.replace(/es$/, "");
  else if (/s$/.test(last) && !/ss$/.test(last)) s = last.replace(/s$/, "");
  return [...parts, s].join("_");
}
const fileBase = (table) => camel(singular(table)) + "Model";
const modelName = (table) => pascal(singular(table));

function dataType(c) {
  const t = c.COLUMN_TYPE.toLowerCase();
  const unsigned = t.includes("unsigned") ? ".UNSIGNED" : "";
  let m;
  if (t.startsWith("bigint")) return `DataTypes.BIGINT${unsigned}`;
  if (t.startsWith("int")) return `DataTypes.INTEGER${unsigned}`;
  if (t.startsWith("smallint")) return `DataTypes.SMALLINT${unsigned}`;
  if (t === "tinyint(1)") return "DataTypes.BOOLEAN";
  if (t.startsWith("tinyint")) return `DataTypes.TINYINT${unsigned}`;
  if ((m = /^decimal\((\d+),(\d+)\)/.exec(t))) return `DataTypes.DECIMAL(${m[1]}, ${m[2]})`;
  if ((m = /^varchar\((\d+)\)/.exec(t))) return `DataTypes.STRING(${m[1]})`;
  if ((m = /^char\((\d+)\)/.exec(t))) return `DataTypes.CHAR(${m[1]})`;
  if (t === "mediumtext") return `DataTypes.TEXT("medium")`;
  if (t === "text") return "DataTypes.TEXT";
  if (t === "json") return "DataTypes.JSON";
  if (t === "date") return "DataTypes.DATEONLY";
  if ((m = /^datetime\((\d)\)/.exec(t))) return `DataTypes.DATE(${m[1]})`;
  if (t === "datetime" || t === "timestamp") return "DataTypes.DATE";
  if (t === "time") return "DataTypes.TIME";
  if (t.startsWith("enum(")) {
    const values = [...t.slice(5, -1).matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    return `DataTypes.ENUM(${values.map((v) => JSON.stringify(v)).join(", ")})`;
  }
  throw new Error(`Unmapped column type ${c.COLUMN_TYPE} on ${c.TABLE_NAME}.${c.COLUMN_NAME}`);
}

function defaultValue(c) {
  if (c.COLUMN_DEFAULT === null) return null;
  const d = String(c.COLUMN_DEFAULT);
  if (/^current_timestamp/i.test(d)) return `sequelize.literal("CURRENT_TIMESTAMP")`;
  const t = c.COLUMN_TYPE.toLowerCase();
  if (t === "tinyint(1)") return d === "1" ? "true" : "false";
  if (/^(big|small|tiny)?int/.test(t)) return String(Number(d));
  return JSON.stringify(d.replace(/^'(.*)'$/, "$1"));
}

const tables = (await select("SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [schema])).map((t) => t.TABLE_NAME);
const columns = await select(
  `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, ORDINAL_POSITION
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [schema]);
const pks = await select(
  `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'`, [schema]);
const fks = await select(
  `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
     FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME, COLUMN_NAME`, [schema]);
const pkSet = new Set(pks.map((p) => `${p.TABLE_NAME}.${p.COLUMN_NAME}`));

// remove previously generated model files (hand-written db.js and index.js are rewritten/kept explicitly)
for (const f of fs.readdirSync(modelsDir)) {
  if (!f.endsWith("Model.js")) continue;
  const src = fs.readFileSync(path.join(modelsDir, f), "utf8");
  if (src.includes("@generated") || f === "userModel.js") fs.unlinkSync(path.join(modelsDir, f));
}

for (const table of tables) {
  const cols = columns.filter((c) => c.TABLE_NAME === table);
  const lines = cols.map((c) => {
    const parts = [`type: ${dataType(c)}`];
    if (pkSet.has(`${table}.${c.COLUMN_NAME}`)) parts.push("primaryKey: true");
    if (/auto_increment/i.test(c.EXTRA)) parts.push("autoIncrement: true");
    parts.push(`allowNull: ${c.IS_NULLABLE === "YES"}`);
    const dv = defaultValue(c);
    if (dv !== null) parts.push(`defaultValue: ${dv}`);
    return `    ${c.COLUMN_NAME}: { ${parts.join(", ")} },`;
  });
  const name = modelName(table);
  const src = `/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// @generated by scripts/generate-models.js from the live \`${table}\` table — do not edit by hand.
// Schema changes go in database/migrations, then run \`npm run models:generate\`.
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const ${name} = sequelize.define(
  "${name}",
  {
${lines.join("\n")}
  },
  { tableName: "${table}", timestamps: false }
);
export { sequelize };
`;
  fs.writeFileSync(path.join(modelsDir, `${fileBase(table)}.js`), src);
}

// ---- index.js with associations ----------------------------------------------------------------------------------------
const assoc = [];
const hasManyCount = new Map();
for (const fk of fks) hasManyCount.set(`${fk.REFERENCED_TABLE_NAME}<${fk.TABLE_NAME}`, (hasManyCount.get(`${fk.REFERENCED_TABLE_NAME}<${fk.TABLE_NAME}`) || 0) + 1);
for (const fk of fks) {
  const child = modelName(fk.TABLE_NAME), parent = modelName(fk.REFERENCED_TABLE_NAME);
  const asOne = camel(fk.COLUMN_NAME.replace(/_id$/, ""));
  const many = hasManyCount.get(`${fk.REFERENCED_TABLE_NAME}<${fk.TABLE_NAME}`) > 1
    ? `${camel(fk.TABLE_NAME)}By${pascal(fk.COLUMN_NAME.replace(/_id$/, ""))}`
    : camel(fk.TABLE_NAME) + (fk.TABLE_NAME === fk.REFERENCED_TABLE_NAME ? "Children" : "");
  assoc.push(`${child}.belongsTo(${parent}, { foreignKey: "${fk.COLUMN_NAME}", targetKey: "${fk.REFERENCED_COLUMN_NAME}", as: "${asOne}", constraints: false });`);
  assoc.push(`${parent}.hasMany(${child}, { foreignKey: "${fk.COLUMN_NAME}", sourceKey: "${fk.REFERENCED_COLUMN_NAME}", as: "${many}", constraints: false });`);
}
const index = `// @generated by scripts/generate-models.js — one model per table + every foreign-key association.
// Import models from here (\`import { Employee, Department } from "../models/index.js"\`) so associations are registered.
import { sequelize } from "./db.js";
${tables.map((t) => `import { ${modelName(t)} } from "./${fileBase(t)}.js";`).join("\n")}

${assoc.join("\n")}

export const models = { ${tables.map((t) => modelName(t)).join(", ")} };
export { sequelize, ${tables.map((t) => modelName(t)).join(", ")} };
`;
fs.writeFileSync(path.join(modelsDir, "index.js"), index);
console.log(`✅ Generated ${tables.length} model files and ${fks.length} associations in models/`);
await sequelize.close();
