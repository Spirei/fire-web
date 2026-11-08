"""Administrator Web controls for migration connections; no runtime connection replacement."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter,Depends,Request,Response,HTTPException

from .database_migration_connections import MigrationConnections,SourceSave,SourceTest
from .database_migration_jobs import PreparationInput,PreparationCancellation,submit,listing,cancel_request
from .security import administrator,Identity
from .fire_web import administrator as fire_administrator


def mount_database_migration(app,db):
    service=MigrationConnections(db)
    app.state.database_migration_connections=service

    def headers(response):
        response.headers['Cache-Control']='no-store, private'
        response.headers['Vary']='Cookie, Authorization'

    def mount(prefix,dependency,key):
        router=APIRouter(prefix=prefix,tags=['database-migration'])
        Admin=Annotated[Identity,Depends(dependency)]

        @router.get('/connections',operation_id=key+'_migration_connections',summary='读取迁移连接',description='读取旧库配置、新库环境连接及当前版本的检查回执；密码只返回是否已配置。')
        async def read(request:Request,response:Response,who:Admin):
            if request.query_params:raise HTTPException(400,'查询字段无效')
            headers(response)
            return await service.read(who)

        @router.put('/source',operation_id=key+'_migration_source_save',summary='保存旧库连接',description='管理员验证后按原配置版本和请求UUID保存迁移来源，密码经Vault加密。')
        async def save(data:SourceSave,response:Response,who:Admin):
            headers(response)
            return await service.save(who,data)

        @router.get('/source/operations/{request_id}',operation_id=key+'_migration_source_receipt',summary='查询旧库保存回执')
        async def receipt(request_id:UUID,response:Response,who:Admin):
            headers(response)
            return await service.receipt(who,request_id)

        @router.post('/source/operations/{request_id}/cancel',operation_id=key+'_migration_source_cancel',summary='取消未确认的旧库保存请求')
        async def cancel_source(request_id:UUID,response:Response,who:Admin):
            headers(response)
            return await service.cancel_save(who,request_id)

        @router.post('/source/test',operation_id=key+'_migration_source_test',summary='测试旧库连接',description='以只读事务核对来源身份、Schema及读取权限，保存此配置版本的检查结果。')
        async def test_source(data:SourceTest,response:Response,who:Admin):
            headers(response)
            if not await app.state.rate_limit(db,'database-migration.probe:'+who.id,10,window_seconds=60):
                raise HTTPException(429,'连接检查过于频繁，请稍后再试')
            return await service.test_source(who,data.revision)

        @router.post('/target/test',operation_id=key+'_migration_target_test',summary='测试新库连接',description='核对当前环境配置指向的运行库及平台身份。')
        async def test_target(response:Response,who:Admin):
            headers(response)
            return await service.test_target(who)

        @router.post('/preparations',status_code=202,operation_id=key+'_migration_preparation',summary='创建迁移准备任务',description='两边检查通过后创建双库一致快照、精确数值副本及隔离恢复核对任务，进度通过原任务回执读取。')
        async def prepare(data:PreparationInput,response:Response,who:Admin):
            headers(response)
            return await submit(db,who,data)

        @router.post('/preparations/cancel',operation_id=key+'_migration_preparation_cancel',summary='按原请求编号取消迁移准备')
        async def cancel_preparation(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id)

        @router.get('/preparations',operation_id=key+'_migration_preparations',summary='读取迁移准备历史')
        async def preparations(response:Response,who:Admin):
            headers(response)
            return await listing(db,who)
        app.include_router(router)

    mount('/api/database-migration',administrator,'canonical')
    mount('/api/fire/database-migration',fire_administrator,'fire')
