'use strict';
const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
function openBusinessDatabase(sqliteFile,options={}){
 const data=path.dirname(path.resolve(sqliteFile));
 if(fs.existsSync(path.join(data,'database-runtime.json'))||fs.existsSync(path.join(data,'database-postgres-required'))){
  if(data!==path.resolve('data'))throw Error('Run PostgreSQL maintenance from the deployed application directory');
  const {runtimePostgresDatabase}=require('../server-tools/postgres/postgresRuntime.js');
  const postgres=runtimePostgresDatabase();if(!postgres)throw Error('PostgreSQL cutover is not complete; refusing SQLite fallback');
  return postgres.asDatabase();
 }
 return new Database(sqliteFile,options);
}
module.exports={openBusinessDatabase};
