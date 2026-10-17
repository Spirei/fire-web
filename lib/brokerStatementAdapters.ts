import { statementConnector } from './brokerConnectors';
import { parseFlexStatement,requestFlex } from './ibkrFlex';
import { RecordsError } from './recordsContract';
export type StatementCredentials={connectorId:string;externalAccount:string;[key:string]:string};
/** Provider-specific credential validation and transport live in adapters, not account logic. */
const adapters={ 'ibkr-flex':{
  parse:parseFlexStatement,
  credentials(b:Record<string,unknown>):StatementCredentials {
    if(typeof b.token!=='string'||!/^[A-Za-z0-9]{10,256}$/.test(b.token)||typeof b.queryId!=='string'||!/^\d{1,20}$/.test(b.queryId)||typeof b.externalAccount!=='string'||! /^[A-Za-z0-9-]{2,40}$/.test(b.externalAccount))throw new RecordsError('请填写有效Token、Query ID和IBKR账户编号');
    return {connectorId:'ibkr-flex',externalAccount:b.externalAccount,token:b.token,queryId:b.queryId};
  },
  fetch:(credentials:StatementCredentials,reference?:string)=>requestFlex(credentials.token,credentials.queryId,reference)
} };
export function statementAdapter(id:string){
  const metadata=statementConnector(id),adapter=adapters[id as keyof typeof adapters];
  if(!metadata||!adapter)throw new RecordsError('此官方账单渠道尚未开放',422);
  return {...metadata,...adapter};
}
