// Splits a .sql file into individual statements, honouring `DELIMITER` lines (needed for triggers).
export function splitSql(text) {
  const statements = [];
  let delimiter = ";";
  let buffer = "";

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const delimMatch = /^DELIMITER\s+(\S+)\s*$/i.exec(line.trim());
    if (delimMatch) {
      delimiter = delimMatch[1];
      continue;
    }
    // skip pure comment / blank lines when no statement is in progress
    if (!buffer.trim() && (line.trim() === "" || line.trim().startsWith("--"))) continue;

    buffer += line + "\n";
    if (line.trim().endsWith(delimiter)) {
      const stmt = buffer.trim().slice(0, -delimiter.length).trim();
      if (stmt) statements.push(stmt);
      buffer = "";
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}
