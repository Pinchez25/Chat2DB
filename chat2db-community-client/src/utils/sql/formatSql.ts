import { DatabaseTypeCode } from '@/constants';
import sqlServer from '@/service/sql';
import { protectSqlParametersForFormatting } from './sqlParameters';

export function formatSql(sql: string, dbType?: DatabaseTypeCode) {
  const protectedSql = protectSqlParametersForFormatting(sql);
  return new Promise((r: (sql: string) => void) => {
    sqlServer
      .sqlFormat({
        sql: protectedSql.sql,
        dbType,
      })
      .then((res) => {
        r(protectedSql.restore(res));
      });
  });
}
