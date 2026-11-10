"""Recurring observations have their own demand quota and cannot block finite admin tasks."""
from uuid import uuid4


async def test_recurring_market_tasks_do_not_exhaust_manual_task_budget(admin,client,app):
    async with app.state.db.connection() as conn:
        for _ in range(106):
            await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,'synthetic','market.latest','queued','{}')",(uuid4(),admin,uuid4()))
    accepted=await client.post('/api/tasks',json={'request_id':str(uuid4()),'kind':'system.diagnostics'})
    assert accepted.status_code==202,accepted.text
    async with app.state.db.connection() as conn:
        for _ in range(99):
            await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,'synthetic','system.diagnostics','queued','{}')",(uuid4(),admin,uuid4()))
    rejected=await client.post('/api/tasks',json={'request_id':str(uuid4()),'kind':'system.diagnostics'})
    assert rejected.status_code==429
