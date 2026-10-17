/** Public adapter metadata only. Account identity and holdings never depend on this list. */
export const BROKER_STATEMENT_CONNECTORS = [{
  id:'ibkr-flex',providerId:'ibkr',label:'IBKR · Flex官方账单',
  helpUrl:'https://www.ibkrguides.com/advisorportal/ug/flex3.htm',
  accept:'.xml,application/xml,text/xml',fileLabel:'Activity Flex XML',maxBytes:8388608,
  externalAccountLabel:'官方账户编号',
  fields:[{key:'externalAccount',label:'官方账户编号',secret:false},{key:'queryId',label:'Flex Query ID',secret:false},{key:'token',label:'Flex Token',secret:true}]
}] as const;
export function statementConnector(id:string){return BROKER_STATEMENT_CONNECTORS.find(c=>c.id===id);}
