"""New-Web Agent delegation only; existing iOS Agent configuration remains independent."""
import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .agent_runtime_service import AgentRuntime
from .profile_http import bounded_body
from .security import identity


def mount_agent_runtime(app,db):
    service=AgentRuntime(db);app.state.agent_runtime=service

    async def who(request):
        if request.headers.get('authorization'):raise HTTPException(403,'请使用当前管理Web会话')
        person=await identity(request)
        if person.role!='admin':raise HTTPException(403,'此独立Agent委派仅对明确批准的当前管理员开放')
        return person

    async def body(request):
        from .fx_provider_parser import unique
        try:return json.loads(await bounded_body(request,1048576),object_pairs_hook=unique,parse_constant=lambda value:(_ for _ in ()).throw(ValueError(value)))
        except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'请求JSON无效') from None

    async def execute(request,action,identifier=None):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie'}
        try:
            person=await who(request)
            if action=='read':result=await service.read(person)
            elif action=='save':result=await service.save(person,await body(request))
            elif action=='submit':result=await service.submit(person,await body(request))
            elif action=='operation':result=await service.operation(person,identifier)
            elif action=='close':result=await service.close(person,identifier)
            else:
                raw=await body(request)
                if not isinstance(raw,dict) or set(raw)-{'password','code'}:raise HTTPException(422,'原件核对参数无效')
                result=await service.original(person,identifier,raw.get('password'),raw.get('code',''))
                return Response(result['raw'],media_type='application/octet-stream',headers={**headers,'Content-Disposition':'attachment; filename="agent-response.bin"','X-Content-SHA256':result['sha256'],'X-Content-Type-Options':'nosniff'})
            return JSONResponse(result,headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'detail':exc.detail},status_code=exc.status_code,headers=headers)
        except Exception:  # noqa: BLE001 - private transport boundary must not expose provider/DB errors
            return JSONResponse({'detail':'Agent私有服务暂不可用'},status_code=503,headers=headers)

    @app.get('/api/agent-runtime/connections')
    async def connections(request:Request):return await execute(request,'read')

    @app.post('/api/agent-runtime/connections')
    async def save(request:Request):return await execute(request,'save')

    @app.post('/api/agent-runtime/operations')
    async def submit(request:Request):return await execute(request,'submit')

    @app.get('/api/agent-runtime/operations/{request_id}')
    async def operation(request_id:UUID,request:Request):return await execute(request,'operation',request_id)

    @app.post('/api/agent-runtime/operations/{request_id}/close')
    async def close(request_id:UUID,request:Request):return await execute(request,'close',request_id)

    @app.post('/api/agent-runtime/originals/{page_id}/download')
    async def original(page_id:UUID,request:Request):return await execute(request,'original',page_id)
