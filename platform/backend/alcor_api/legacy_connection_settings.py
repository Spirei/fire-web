"""Old PG declaration uses Connections preflight and its same-transaction finalizer."""
from uuid import UUID,uuid5
from fastapi import HTTPException
from psycopg.types.json import Jsonb
from .connection_models import ConnectionInput,PostgresConfig
from .connections import config_model,current_config
from .security import digest,lock_mutation_identity

KEYS={'dbType','pgHost','pgPort','pgDatabase','pgUser','pgPassword'}


async def prepare(db,service,who,parent_id,raw,verifier,password,code):
    if not KEYS&set(raw):return None
    if raw.get('dbType','postgres')not in ('postgres','postgresql'):raise HTTPException(409,'当前平台为PostgreSQL，不能通过设置切换或覆盖为旧SQLite账本')
    async with db.connection()as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        if password:
            user=await verifier.step_up(conn,who,password,code)
            await conn.execute("INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at)VALUES(%s,'connection-reauth',%s,%s,%s,clock_timestamp()+interval '15 minutes')ON CONFLICT(id)DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at",(digest('connection-reauth:'+who.token_hash),who.id,who.token_hash,Jsonb({'session_version':user['session_version']})))
        row=await service.row(conn,'postgresql')
        config=config_model(row['config'])if row else current_config(service.base,'postgresql')[0]
        patch=config.model_dump()
        for old,new in (('pgHost','host'),('pgDatabase','database'),('pgUser','username')):
            if old in raw:patch[new]=raw[old]
        if 'pgPort'in raw:
            value=raw['pgPort']
            if isinstance(value,str)and value.isascii()and value.isdecimal():value=int(value)
            if type(value)is not int or not 1<=value<=65535:raise HTTPException(422,'PostgreSQL端口无效')
            patch['port']=value
        secret=raw.get('pgPassword')
        mode='keep'if secret in (None,'','********')else'replace'
        try:data=ConnectionInput(request_id=uuid5(UUID(str(parent_id)),'legacy-settings-postgresql'),revision=row['revision']if row else None,config=PostgresConfig.model_validate(patch),password_mode=mode,password=secret if mode=='replace'else None)
        except ValueError:raise HTTPException(422,'数据库声明无效')from None
    prepared=await service.preflight(who,data,'save')
    return data,prepared
