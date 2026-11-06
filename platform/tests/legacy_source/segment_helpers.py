import copy
from uuid import uuid4

import httpx
import pytest
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb

from .helpers import authorized,export,target
from .synthetic_legacy import OWNER


async def imported(client,admin,old_pg):
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    account,record=await target(client)
    command={'requestId':str(uuid4()),'sourceId':snapshot['sourceId'],'sourceHash':snapshot['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':admin,'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=command);assert response.status_code==200 and response.json()['ready'],response.text
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':response.json()['preview']});assert response.status_code==200 and response.json()['financialApplied'],response.text
    return grant,snapshot,account,record,command
