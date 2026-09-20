import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSqlParameterPrompts,
  findSqlParameters,
  materializeSqlParameters,
  MissingSqlParameterError,
  protectSqlParametersForFormatting,
  type SqlParameterOptions,
} from './sqlParameters';

const keysOf = (sql: string, options?: SqlParameterOptions) => findSqlParameters(sql, options).map(({ key }) => key);
const fill = (sql: string, entries: Record<string, string>, options?: SqlParameterOptions) =>
  materializeSqlParameters(sql, new Map(Object.entries(entries)), options);

describe('findSqlParameters', () => {
  it('finds named and positional parameters, de-duplicating named ones', () => {
    assert.deepEqual(findSqlParameters('SELECT :a, ?, :a, ?, :b'), [
      { key: 'a', label: 'a' },
      { key: '?1', label: 'Parameter 1' },
      { key: '?2', label: 'Parameter 2' },
      { key: 'b', label: 'b' },
    ]);
  });

  it('ignores parameters inside strings, identifiers and comments', () => {
    const sql = `SELECT 'it''s :a', "x :b", \`y :c\`, 'esc\\' :d' -- :e
      /* :f ? */ , :real`;
    assert.deepEqual(keysOf(sql), ['real']);
  });

  it('does not treat `::` casts, `:=` or `:1` as parameters', () => {
    assert.deepEqual(keysOf('SELECT x::int, @v := 1, 10:30, :ok'), ['ok']);
  });

  it('does not let backslash escape inside backtick identifiers', () => {
    assert.deepEqual(keysOf('SELECT `a\\`, :x'), ['x']);
  });

  it('honours backslashEscapes: false', () => {
    assert.deepEqual(keysOf("SELECT 'C:\\', :x", { backslashEscapes: false }), ['x']);
    assert.deepEqual(keysOf("SELECT 'C:\\', :x"), []); // default: `\'` escapes the quote
  });

  it('honours hashComments', () => {
    assert.deepEqual(keysOf("SELECT 1 # don't\n, :x", { hashComments: true }), ['x']);
  });

  it('does not let `/*/` close itself', () => {
    assert.deepEqual(keysOf('SELECT /*/ :x */ :y'), ['y']);
  });

  it('supports Unicode parameter names', () => {
    assert.deepEqual(keysOf('SELECT :año, :名前1'), ['año', '名前1']);
  });

  it('tolerates unterminated strings and comments', () => {
    assert.deepEqual(keysOf("SELECT :a, 'oops :b"), ['a']);
    assert.deepEqual(keysOf('SELECT :a /* oops :b'), ['a']);
    assert.deepEqual(keysOf('SELECT :a -- oops :b'), ['a']);
    assert.deepEqual(keysOf(''), []);
    assert.deepEqual(keysOf(':'), []);
  });
});

describe('buildSqlParameterPrompts', () => {
  it('returns named and positional parameters in execution order for UI prompts', () => {
    assert.deepEqual(buildSqlParameterPrompts('SELECT * FROM users WHERE email = :email AND status = :status AND id = ?'), [
      { key: 'email', label: 'email' },
      { key: 'status', label: 'status' },
      { key: '?1', label: 'Parameter 1' },
    ]);
  });
});

describe('materializeSqlParameters', () => {
  it('emits numbers, booleans and null unquoted (trimmed)', () => {
    assert.equal(fill('? ? ? ? ? ?', { '?1': ' 42 ', '?2': '-0.5', '?3': '.5', '?4': 'NULL', '?5': 'true', '?6': '0' }),
      '42 -0.5 .5 NULL true 0');
  });

  it('quotes values that merely look numeric but are not safe as numbers', () => {
    assert.equal(fill(':a :b :c :d', { a: '007', b: '0712345678', c: '1e5', d: '1.' }),
      "'007' '0712345678' '1e5' '1.'");
  });

  it('quotes empty strings', () => {
    assert.equal(fill(':a', { a: '' }), "''");
  });

  it('escapes quotes and, by default, backslashes (no break-out via \\\')', () => {
    assert.equal(fill(':a', { a: "\\' OR 1=1 -- " }), "'\\\\'' OR 1=1 -- '");
    assert.equal(fill(':a', { a: 'trailing\\' }), "'trailing\\\\'");
  });

  it('does not double backslashes when backslashEscapes is false', () => {
    assert.equal(fill(':a', { a: "a\\'b" }, { backslashEscapes: false }), "'a\\''b'");
  });

  it('keeps `5 -` + `-3` from becoming a `--` comment', () => {
    assert.equal(fill('SELECT 5 -:a', { a: '-3' }), 'SELECT 5 - -3');
    assert.equal(fill('SELECT 5 - :a', { a: '-3' }), 'SELECT 5 - -3');
  });

  it('substitutes repeated named parameters everywhere and leaves other text untouched', () => {
    assert.equal(fill("SELECT ':a', :a, :a::text -- :a", { a: 'x' }), "SELECT ':a', 'x', 'x'::text -- :a");
  });

  it('does not interpret `$&`-style replacement patterns in values', () => {
    assert.equal(fill(':a', { a: "$& $' $1" }), "'$& $'' $1'");
  });

  it('throws MissingSqlParameterError listing every missing key once', () => {
    assert.throws(
      () => fill('SELECT :a, :a, ?, :b', { b: '1' }),
      (error: unknown) =>
        error instanceof MissingSqlParameterError && error.keys.join() === 'a,?1',
    );
  });

  it('rejects NUL characters in string values', () => {
    assert.throws(() => fill(':a', { a: 'x\u0000y' }), RangeError);
  });
});

describe('protectSqlParametersForFormatting', () => {
  it('restores named and positional parameters after formatting', () => {
    const protectedSql = protectSqlParametersForFormatting('SELECT :id, ?, :id');
    assert.match(protectedSql.sql, /__CHAT2DB_SQL_PARAMETER_0__/);
    assert.doesNotMatch(protectedSql.sql, /:id|\?/);
    assert.equal(
      protectedSql.restore(protectedSql.sql.replace(/\s*,\s*/g, ',\n')),
      'SELECT :id,\n?,\n:id',
    );
  });
});
