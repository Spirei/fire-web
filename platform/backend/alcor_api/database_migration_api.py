"""Administrator Web controls for migration connections; no runtime connection replacement."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter,Depends,Request,Response,HTTPException

from .database_migration_connections import MigrationConnections,SourceSave,SourceTest
from .database_migration_jobs import PreparationInput,PreparationCancellation,submit,listing,cancel_request
from .database_migration_retry import PreparationRetry,submit_retry
from .database_migration_conversion import ConversionInput,context as conversion_context,submit as submit_conversion
from .database_migration_portfolio import PortfolioImportInput,submit as submit_portfolio
from .database_migration_history import submit as submit_history
from .database_migration_completion import submit as submit_completion
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

        @router.post('/preparations/{task_id}/retry',status_code=202,operation_id=key+'_migration_preparation_retry',summary='重试未完成的迁移准备步骤',description='复用原归档和已完成的隔离恢复核对，仅执行未完成步骤；不重新采集或写入业务数据。')
        async def retry_preparation(task_id:UUID,data:PreparationRetry,response:Response,who:Admin):
            headers(response)
            return await submit_retry(db,who,task_id,data)

        @router.post('/preparations/cancel',operation_id=key+'_migration_preparation_cancel',summary='按原请求编号取消迁移准备')
        async def cancel_preparation(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id)

        @router.post('/conversions/cancel',operation_id=key+'_migration_conversion_cancel',summary='取消数据转换或未确认的转换请求')
        async def cancel_conversion(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id,kind='database.migration.convert')

        @router.post('/conversions/{task_id}/portfolio',status_code=202,operation_id=key+'_migration_portfolio',summary='导入持仓与自选',description='按已核对转换计划原值导入当前登记持仓、自选和券商分组；不重放成交、不补零费用、不入现金、不切换身份。')
        async def import_portfolio(task_id:UUID,data:PortfolioImportInput,response:Response,who:Admin):
            headers(response)
            return await submit_portfolio(db,who,task_id,data)

        @router.post('/portfolio/cancel',operation_id=key+'_migration_portfolio_cancel',summary='取消持仓与自选导入请求')
        async def cancel_portfolio(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id,kind='database.migration.portfolio')

        @router.post('/conversions/{task_id}/history',status_code=202,operation_id=key+'_migration_history',summary='导入历史交易与资金',description='复用原转换计划和持仓映射，原值保存交易、资金及费用证据；不重复执行交易、不重算持仓，不把未核对费用当作实付。')
        async def import_history(task_id:UUID,data:PortfolioImportInput,response:Response,who:Admin):
            headers(response)
            return await submit_history(db,who,task_id,data)

        @router.post('/history/cancel',operation_id=key+'_migration_history_cancel',summary='取消历史导入请求')
        async def cancel_history(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id,kind='database.migration.history')

        @router.post('/conversions/{task_id}/complete',status_code=202,operation_id=key+'_migration_complete',summary='完成剩余数据迁移',description='先备份新库，接续原历史、素材、个人数据及旧账号安全信息；已完成部分复用，身份切换最后提交，完成后使用旧账号重新登录。')
        async def complete_migration(task_id:UUID,data:PortfolioImportInput,response:Response,who:Admin):
            headers(response)
            return await submit_completion(db,who,task_id,data)

        @router.post('/completion/cancel',operation_id=key+'_migration_completion_cancel',summary='停止剩余迁移步骤')
        async def cancel_completion(data:PreparationCancellation,response:Response,who:Admin):
            headers(response)
            return await cancel_request(db,who,data.request_id,kind='database.migration.complete')

        @router.get('/preparations/{task_id}/conversion',operation_id=key+'_migration_conversion_context',summary='读取数据转换范围与记录')
        async def conversion_read(task_id:UUID,response:Response,who:Admin):
            headers(response)
            return await conversion_context(db,who,task_id)

        @router.post('/preparations/{task_id}/conversion',status_code=202,operation_id=key+'_migration_conversion',summary='转换并校验业务数据',description='复用已恢复核对的归档，保留原值与来源，转换业务结构并列出账户、交易、资金及文件差异；不会自动导入。')
        async def convert(task_id:UUID,data:ConversionInput,response:Response,who:Admin):
            headers(response)
            return await submit_conversion(db,who,task_id,data)

        @router.get('/preparations',operation_id=key+'_migration_preparations',summary='读取迁移准备历史')
        async def preparations(response:Response,who:Admin):
            headers(response)
            return await listing(db,who)
        app.include_router(router)

    mount('/api/database-migration',administrator,'canonical')
    mount('/api/fire/database-migration',fire_administrator,'fire')
