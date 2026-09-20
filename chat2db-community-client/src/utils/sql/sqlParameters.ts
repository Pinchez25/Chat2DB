/**
 * Finds `?` and `:name` parameters in SQL text and substitutes them with SQL literals.
 * Anything inside string literals, quoted identifiers and comments is ignored.
 *
 * SECURITY: `materializeSqlParameters` builds SQL by client-side string escaping. That is only
 * as safe as the scanner's and the escaper's assumptions about the server's lexing rules, so both
 * are driven by the same `SqlParameterOptions`. Where you control the execution path, prefer
 * server-side parameter binding (prepared statements) over this. Client-side escaping is also not
 * a defence against multi-byte connection character sets (e.g. GBK) that can swallow a backslash.
 */

export interface SqlParameter {
  key: string;
  label: string;
}

export interface SqlParameterOptions {
  /**
   * Treat `\` as an escape character inside '...' and "..." (MySQL/MariaDB default behaviour).
   * Set to false for engines/modes where it is an ordinary character (e.g. standard SQL,
   * MySQL with NO_BACKSLASH_ESCAPES). Must match the server, otherwise the scanner and the
   * escaper disagree with the database about where a string ends. Default: true.
   */
  backslashEscapes?: boolean;
  /** Treat `#` as the start of a line comment (MySQL/MariaDB). Default: false. */
  hashComments?: boolean;
}

export class MissingSqlParameterError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`No value supplied for SQL parameter(s): ${keys.join(', ')}`);
    this.name = 'MissingSqlParameterError';
    this.keys = keys;
  }
}

interface SqlParameterOccurrence {
  start: number;
  end: number;
  key: string;
}

export interface ProtectedSqlParameters {
  sql: string;
  restore: (formattedSql: string) => string;
}

type ResolvedOptions = Required<SqlParameterOptions>;

const POSITIONAL_PREFIX = '?';

// Sticky, so it only matches at `lastIndex`. `lastIndex` is always set before use.
const NAMED_PARAMETER = /[\p{L}_][\p{L}\p{N}_$]*/uy;
// No leading zeros ("007" and "0712…" are identifiers/strings, not numbers).
const NUMERIC_LITERAL = /^-?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)$/;
const KEYWORD_LITERAL = /^(?:null|true|false)$/i;

export function buildSqlParameterPrompts(sql: string, options?: SqlParameterOptions): SqlParameter[] {
  return findSqlParameters(sql, options);
}

export function findSqlParameters(sql: string, options?: SqlParameterOptions): SqlParameter[] {
  const parameters = new Map<string, SqlParameter>();
  for (const { key } of scanSqlParameters(sql, resolveOptions(options))) {
    if (!parameters.has(key)) {
      parameters.set(key, { key, label: toLabel(key) });
    }
  }
  return [...parameters.values()];
}

/**
 * @throws MissingSqlParameterError if any parameter has no entry in `values`.
 * @throws RangeError if a value that would be emitted as a string contains a NUL character.
 */
export function materializeSqlParameters(
  sql: string,
  values: ReadonlyMap<string, string>,
  options?: SqlParameterOptions,
): string {
  const resolved = resolveOptions(options);
  const occurrences = scanSqlParameters(sql, resolved);

  const missing = new Set<string>();
  for (const { key } of occurrences) {
    if (!values.has(key)) {
      missing.add(key);
    }
  }
  if (missing.size > 0) {
    throw new MissingSqlParameterError([...missing]);
  }

  const parts: string[] = [];
  let offset = 0;
  for (const { start, end, key } of occurrences) {
    const literal = toSqlLiteral(values.get(key) as string, resolved);
    // `5 -` + `-3` must not fuse into `--3`, which starts a line comment.
    const separator = literal.startsWith('-') && sql[start - 1] === '-' ? ' ' : '';
    parts.push(sql.slice(offset, start), separator, literal);
    offset = end;
  }
  parts.push(sql.slice(offset));
  return parts.join('');
}

/** Protect editor parameters from a formatter that does not understand `:name` syntax. */
export function protectSqlParametersForFormatting(
  sql: string,
  options?: SqlParameterOptions,
): ProtectedSqlParameters {
  const occurrences = scanSqlParameters(sql, resolveOptions(options));
  if (!occurrences.length) {
    return { sql, restore: (formattedSql) => formattedSql };
  }

  const placeholders = occurrences.map((occurrence, index) => ({
    token: `__CHAT2DB_SQL_PARAMETER_${index}__`,
    value: sql.slice(occurrence.start, occurrence.end),
  }));
  const parts: string[] = [];
  let offset = 0;
  occurrences.forEach((occurrence, index) => {
    parts.push(sql.slice(offset, occurrence.start), placeholders[index].token);
    offset = occurrence.end;
  });
  parts.push(sql.slice(offset));

  return {
    sql: parts.join(''),
    restore: (formattedSql) =>
      formattedSql.replace(/__CHAT2DB_SQL_PARAMETER_(\d+)__/g, (token, index) => {
        const placeholder = placeholders[Number(index)];
        return placeholder ? placeholder.value : token;
      }),
  };
}

function resolveOptions(options: SqlParameterOptions = {}): ResolvedOptions {
  return {
    backslashEscapes: options.backslashEscapes ?? true,
    hashComments: options.hashComments ?? false,
  };
}

function toLabel(key: string): string {
  return key.startsWith(POSITIONAL_PREFIX) ? `Parameter ${key.slice(POSITIONAL_PREFIX.length)}` : key;
}

function scanSqlParameters(sql: string, { backslashEscapes, hashComments }: ResolvedOptions): SqlParameterOccurrence[] {
  const occurrences: SqlParameterOccurrence[] = [];
  let positionalIndex = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'" || char === '"' || char === '`') {
      // Backslash is never an escape inside backtick-quoted identifiers.
      index = skipQuoted(sql, index, backslashEscapes && char !== '`');
    } else if ((char === '-' && next === '-') || (hashComments && char === '#')) {
      index = skipLineComment(sql, index);
    } else if (char === '/' && next === '*') {
      index = skipBlockComment(sql, index);
    } else if (char === '?') {
      positionalIndex += 1;
      occurrences.push({ start: index, end: index + 1, key: `${POSITIONAL_PREFIX}${positionalIndex}` });
      index += 1;
    } else if (char === ':' && next === ':') {
      index += 2; // `::` cast operator: skip both colons so `::int` is not read as `:int`
    } else if (char === ':') {
      NAMED_PARAMETER.lastIndex = index + 1;
      const match = NAMED_PARAMETER.exec(sql);
      if (match) {
        const end = index + 1 + match[0].length;
        occurrences.push({ start: index, end, key: match[0] });
        index = end;
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }

  return occurrences;
}

/** Returns the index just past the closing quote, or `sql.length` if the literal is unterminated. */
function skipQuoted(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql[start];
  let index = start + 1;

  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      index += 2;
    } else if (char !== quote) {
      index += 1;
    } else if (sql[index + 1] === quote) {
      index += 2; // doubled quote is an escaped quote, not the end of the literal
    } else {
      return index + 1;
    }
  }
  return sql.length;
}

/** Returns the index of the line terminator (or `sql.length`). */
function skipLineComment(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
    index += 1;
  }
  return index;
}

/** Returns the index just past `*\/`, or `sql.length` if the comment is unterminated. */
function skipBlockComment(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2); // `+ 2` so that `/*/` does not close itself
  return close === -1 ? sql.length : close + 2;
}

function toSqlLiteral(value: string, { backslashEscapes }: ResolvedOptions): string {
  const trimmed = value.trim();
  if (KEYWORD_LITERAL.test(trimmed) || NUMERIC_LITERAL.test(trimmed)) {
    return trimmed;
  }
  if (value.includes('\0')) {
    throw new RangeError('SQL parameter values must not contain NUL characters.');
  }
  // Single pass, so a backslash we add is never re-escaped.
  const escaped = backslashEscapes
    ? value.replace(/[\\']/g, (char) => (char === '\\' ? '\\\\' : "''"))
    : value.replace(/'/g, "''");
  return `'${escaped}'`;
}
