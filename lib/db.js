import { QueryTypes } from "sequelize";
import { sequelize } from "../models/db.js";

// Thin helpers over Sequelize's connection. All values go through replacements (escaped), never string-concatenated.
// Pass `trx` (from tx()) to run inside a transaction.

export const select = (sql, params = [], trx = null) =>
  sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT, transaction: trx });

export const selectOne = async (sql, params = [], trx = null) => (await select(sql, params, trx))[0] || null;

export const scalar = async (sql, params = [], trx = null) => {
  const row = await selectOne(sql, params, trx);
  return row ? Object.values(row)[0] : null;
};

// INSERT/UPDATE/DELETE. Returns { insertId, affectedRows }.
// Note: for INSERT statements Sequelize's mysql dialect returns [insertId, affectedRows] (numbers) even in RAW mode;
// for every other statement it returns [ResultSetHeader, ResultSetHeader]. Both shapes are handled here.
export const exec = async (sql, params = [], trx = null) => {
  const out = await sequelize.query(sql, { replacements: params, type: QueryTypes.RAW, transaction: trx });
  if (typeof out[0] === "number") return { insertId: out[0], affectedRows: Number(out[1]) || 0 };
  const header = out[0] || {};
  return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
};

export const tx = (fn) => sequelize.transaction(fn);

export { sequelize };
