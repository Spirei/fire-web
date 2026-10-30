/** The application's SQL subset. Values are always bound separately; literals are never rewritten. */
export interface SqlToken { text: string; kind: "word" | "literal" | "symbol" | "parameter"; }
export function sqlTokens(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; continue; }
    if (sql.startsWith("/*", i)) { const end = sql.indexOf("*/", i + 2); if (end < 0) throw Error("Unclosed SQL comment"); i = end + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const start = i++, quote = c;
      for (;;) { if (i >= sql.length) throw Error("Unclosed SQL literal"); if (sql[i++] === quote) { if (sql[i] === quote) i++; else break; } }
      out.push({ text: sql.slice(start, i), kind: quote === "'" ? "literal" : "word" }); continue;
    }
    const parameter = sql.slice(i).match(/^(?:\?|[@:$][A-Za-z_]\w*)/);
    if (parameter) { out.push({ text: parameter[0], kind: "parameter" }); i += parameter[0].length; continue; }
    const word = sql.slice(i).match(/^[A-Za-z_]\w*/);
    if (word) { out.push({ text: word[0], kind: "word" }); i += word[0].length; continue; }
    const op = sql.slice(i).match(/^(?:!=|<>|<=|>=|\|\||\d+(?:\.\d+)?)/)?.[0] ?? c;
    out.push({ text: op, kind: "symbol" }); i += op.length;
  }
  return out;
}
const upper = (t: SqlToken | undefined) => t?.text.toUpperCase();
function sqliteNullOrdering(tokens: SqlToken[]) {
  const additions: { at: number; text: string }[] = [];
  for (let i=0;i<tokens.length-1;i++) if(upper(tokens[i])==='ORDER'&&upper(tokens[i+1])==='BY') {
    let start=i+2,depth=0;
    const finish=(end:number)=>{const term=tokens.slice(start,end);if(term.length&&!term.some(t=>upper(t)==='NULLS')) additions.push({at:end,text:upper(term.at(-1))==='DESC'?'NULLS LAST':'NULLS FIRST'});};
    for(let j=start;j<=tokens.length;j++) {
      const t=tokens[j],u=upper(t);
      if(j===tokens.length||depth===0&&(t.text===')'||['LIMIT','OFFSET','FETCH','FOR','UNION','EXCEPT','INTERSECT','RETURNING',';'].includes(u??''))){finish(j);break;}
      if(t.text==='(')depth++;else if(t.text===')')depth--;
      if(t.text===','&&depth===0){finish(j);start=j+1;}
    }
  }
  for(const a of additions.sort((a,b)=>b.at-a.at))tokens.splice(a.at,0,{text:a.text,kind:'word'});
}
export const identifier = (s: string) => {
  if (!/^[A-Za-z_]\w*$/.test(s)) throw Error("Invalid database identifier");
  return '"' + s + '"';
};
export const tokenName = (s: string) => s.replace(/^["`]|["`]$/g, "");
export const renderSql = (t: SqlToken[]) => t.map(t => t.text).join(" ");
export function splitSql(sql: string): string[] {
  const tokens = sqlTokens(sql), out: string[] = []; let start = 0, trigger = false, body = false, cases = 0;
  for (let i = 0; i < tokens.length; i++) {
    const u = upper(tokens[i]);
    if (i === start) trigger = u === "CREATE" && tokens.slice(i + 1, i + 5).some(t => upper(t) === "TRIGGER");
    if (trigger) {
      if (u === "CASE") cases++;
      if (u === "BEGIN") body = true;
      if (u === "END") { if (cases) cases--; else body = false; }
    }
    if (tokens[i].text === ";" && !body) { out.push(renderSql(tokens.slice(start, i))); start = i + 1; trigger = false; }
  }
  if (start < tokens.length) out.push(renderSql(tokens.slice(start)));
  return out.filter(Boolean);
}
function globRegex(value: string) {
  const pattern = value.slice(1, -1).replaceAll("''", "'"); let out = "^", bracket = false;
  for (const c of pattern) {
    if (c === "[") { bracket = true; out += c; }
    else if (c === "]") { bracket = false; out += c; }
    else if (bracket) out += c;
    else if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else out += c.replace(/[.()+^$|{}\\]/g, "\\$&");
  }
  return "'" + (out + "$").replaceAll("'", "''") + "'";
}
export interface SqlTableInfo { columns: string[]; primaryKey: string[]; }
export function postgresSql(sql: string, info?: (name: string) => SqlTableInfo): string {
  let tokens = sqlTokens(sql); while (tokens.at(-1)?.text === ";") tokens.pop();
  const isCreateTable = upper(tokens[0]) === "CREATE" && upper(tokens[1]) === "TABLE";
  const isSchema = isCreateTable || upper(tokens[0]) === "ALTER" && upper(tokens[1]) === "TABLE";
  const insert = upper(tokens[0]) === "INSERT";
  let conflict: "IGNORE" | "REPLACE" | null = null;
  if (insert && upper(tokens[1]) === "OR") { const u = upper(tokens[2]); if (u !== "IGNORE" && u !== "REPLACE") throw Error("Unsupported conflict mode"); conflict = u; tokens.splice(1, 2); }
  const into = tokens.findIndex(t => upper(t) === "INTO"), table = insert ? tokenName(tokens[into + 1]?.text ?? "") : "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], u = upper(t);
    if (t.kind === "literal" || t.kind === "parameter") continue;
    if (u === "AUTOINCREMENT") { tokens.splice(i--, 1); continue; }
    if (u === "REAL" && isSchema) t.text = "NUMERIC";
    if (u === "INTEGER" && isSchema) t.text = isCreateTable && upper(tokens[i+1]) === "PRIMARY" && upper(tokens[i+2]) === "KEY" ? "BIGINT GENERATED BY DEFAULT AS IDENTITY" : "BIGINT";
    if (u === "BLOB" && isSchema) t.text = "BYTEA";
    if (u === "ROWID") t.text = "_alcor_rowid";
    if (u === "LIKE") t.text = "ILIKE";
    if (u === "LIMIT" && tokens[i + 1]?.text === "-" && tokens[i + 2]?.text === "1") tokens.splice(i + 1, 2, { text: "ALL", kind: "word" });
    if (u === "IS") {
      const not = upper(tokens[i + 1]) === "NOT", j = i + (not ? 2 : 1);
      if (!["NULL", "TRUE", "FALSE", "UNKNOWN", "DISTINCT"].includes(upper(tokens[j]) ?? "")) {
        tokens.splice(i, not ? 2 : 1, { text: not ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM", kind: "symbol" });
      }
    }
    if (u === "GLOB") {
      if (tokens[i + 1]?.kind !== "literal") throw Error("GLOB requires a constant pattern");
      const negated = upper(tokens[i - 1]) === "NOT";
      t.text = negated ? "!~" : "~"; tokens[i + 1].text = globRegex(tokens[i + 1].text);
      if (negated) { tokens.splice(i - 1, 1); i--; }
    }
    if (u === "COLLATE" && upper(tokens[i + 1]) === "NOCASE") {
      if (isCreateTable) { tokens.splice(i, 2); i--; }
      else {
        let from = i - 1; if (tokens[from - 1]?.text === ".") from -= 2;
        const expression = renderSql(tokens.slice(from, i));
        tokens.splice(from, i + 2 - from, { text: `alcor_nocase(${expression})`, kind: "word" }); i = from;
      }
    }
    if (tokens[i + 1]?.text === "(") {
      if (u === "IFNULL") t.text = "coalesce";
      if (u === "INSTR") t.text = "strpos";
      if (u === "JSON_OBJECT") t.text = "alcor_json_object";
      if (u === "MAX" || u === "MIN") {
        let depth = 0, commas = 0;
        for (let j = i + 1; j < tokens.length; j++) { if (tokens[j].text === "(") depth++; else if (tokens[j].text === ")" && --depth === 0) break; else if (tokens[j].text === "," && depth === 1) commas++; }
        if (commas) t.text = u === "MAX" ? "greatest" : "least";
      }
    }
  }
  if (insert) {
    const conflictAt = tokens.findIndex(t => upper(t) === "CONFLICT");
    const updateAt = tokens.findIndex((t,i) => i > conflictAt && upper(t) === "UPDATE");
    const setAt = tokens.findIndex((t,i) => i > updateAt && upper(t) === "SET");
    if (conflictAt >= 0 && updateAt >= 0 && setAt >= 0) {
      const columnStart = into + 2, columnEnd = tokens.findIndex((t,i) => i > columnStart && t.text === ")");
      const columns = info ? info(table).columns : tokens[columnStart]?.text === "(" ? tokens.slice(columnStart+1,columnEnd).filter(t=>t.text!==",").map(t=>tokenName(t.text)) : [];
      const names = new Set(columns.map(c => c.toLowerCase())); let depth = 0, assignment = true;
      for (let i = setAt + 1; i < tokens.length; i++) {
        const t = tokens[i], u = upper(t);
        const lhs = assignment && depth === 0; if (lhs) assignment = false;
        if (!lhs && t.kind === "word" && names.has(tokenName(t.text).toLowerCase()) && tokens[i-1]?.text !== "." && tokens[i+1]?.text !== "." && tokens[i+1]?.text !== "(") t.text = identifier(table)+"."+identifier(tokenName(t.text));
        if (t.text === "(") depth++; else if (t.text === ")") depth--;
        if (t.text === "," && depth === 0) assignment = true;
        if (u === "WHERE" || u === "RETURNING") assignment = false;
      }
    }
  }
  const aliases = new Map<string,string>();
  for (let i=1;i<tokens.length;i++) if (upper(tokens[i-1]) === "AS" && tokens[i].kind === "word" && /[a-z]/.test(tokens[i].text) && /[A-Z]/.test(tokens[i].text)) aliases.set(tokenName(tokens[i].text).toLowerCase(),tokenName(tokens[i].text));
  for (const token of tokens) if (token.kind === "word" && aliases.has(tokenName(token.text).toLowerCase())) token.text = identifier(aliases.get(tokenName(token.text).toLowerCase())!);
  sqliteNullOrdering(tokens);
  let text = renderSql(tokens);
  // User deletion cascades through both positions and orders. Validate dependent RESTRICT links at commit.
  if (isCreateTable) text = text.replace(/ON DELETE RESTRICT/gi, "ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED");
  // PostgreSQL's ON CONFLICT scope includes excluded; qualify counters on the existing row.
  if (insert) text = text.replace(/(\bSET|,)\s*(\w+)\s*=\s*\2\s*\+/gi, (_s, sep, field) => `${sep} ${field} = ${identifier(table)}.${field} +`);
  if (conflict && !tokens.some(t => upper(t) === "CONFLICT")) {
    if (conflict === "IGNORE") text += " ON CONFLICT DO NOTHING";
    else {
      if (!info) throw Error("REPLACE requires primary key metadata");
      const metadata = info(table); if (!metadata.primaryKey.length) throw Error("REPLACE requires a primary key");
      const columnStart = into + 2; let columns = metadata.columns;
      if (tokens[columnStart]?.text === "(") { const end = tokens.findIndex((t, i) => i > columnStart && t.text === ")"); columns = tokens.slice(columnStart + 1, end).filter(t => t.text !== ",").map(t => tokenName(t.text)); }
      text += ` ON CONFLICT (${metadata.primaryKey.map(identifier).join(",")}) DO UPDATE SET ${columns.map(c => `${identifier(c)}=excluded.${identifier(c)}`).join(",")}`;
    }
  }
  return text;
}
export function bindSql(sql: string, args: unknown[]): { sql: string; values: unknown[] } {
  const tokens = sqlTokens(sql), values: unknown[] = [], named = args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0]) && !ArrayBuffer.isView(args[0]) ? args[0] as Record<string, unknown> : null;
  const positional = args.length === 1 && Array.isArray(args[0]) ? args[0] : args; let n = 0;
  for (const t of tokens) if (t.kind === "parameter") {
    let value: unknown;
    if (t.text === "?") { if (named || n >= positional.length) throw Error("Missing SQL parameter"); value = positional[n++]; }
    else { const name = t.text.slice(1); if (!named || !(name in named)) throw Error("Missing named SQL parameter " + name); value = named[name]; }
    if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw Error("Invalid SQL parameter");
    values.push(value); t.text = "$" + values.length;
  }
  if (!named && n !== positional.length) throw Error("Unexpected SQL parameter");
  return { sql: renderSql(tokens), values };
}
export function postgresTrigger(sql: string, schema: string): { name: string; table: string; sql: string; ifNotExists: boolean } {
  const tokens = sqlTokens(sql); let i = 2;
  const ifNotExists = upper(tokens[i]) === "IF"; if (ifNotExists) i += 3;
  const name = tokenName(tokens[i++].text), timing = upper(tokens[i++]);
  if (!["BEFORE", "AFTER"].includes(timing ?? "")) throw Error("Unsupported trigger timing");
  const on = tokens.findIndex((t, at) => at >= i && upper(t) === "ON"), table = tokenName(tokens[on + 1]?.text ?? "");
  const begin = tokens.findIndex((t, at) => at > on && upper(t) === "BEGIN");
  const when = upper(tokens[on + 2]) === "WHEN" ? renderSql(tokens.slice(on + 3, begin)) : "";
  const body = splitSql(renderSql(tokens.slice(begin + 1, tokens.length - (upper(tokens.at(-1)) === "END" ? 1 : 2))));
  if (on < 0 || begin < 0 || !name || !table) throw Error("Unsupported trigger definition");
  const statements = body.map(s => {
    const raise = s.match(/^SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*('(?:[^']|'')*')\s*\)$/i);
    if (raise) return `RAISE EXCEPTION ${raise[1]}`;
    return postgresSql(s).replace(/^SELECT\b/i, "PERFORM");
  }).join(";\n");
  const fn = identifier(schema) + "." + identifier("trigger_" + name);
  const condition = when ? `IF ${postgresSql(when)} THEN\n${statements};\nEND IF;` : statements + ";";
  return { name, table, ifNotExists, sql: `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path=${identifier(schema)},pg_catalog AS $alcor_trigger$ BEGIN\n${condition}\nIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END $alcor_trigger$;\nCREATE TRIGGER ${identifier(name)} ${timing} ${renderSql(tokens.slice(i, on))} ON ${identifier(schema)}.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION ${fn}()` };
}
