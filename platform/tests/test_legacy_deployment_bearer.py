"""Old Web bearer permissions remain distinct from browser and App realms."""
from uuid import uuid4

from alcor_api.security import COOKIE, digest
from test_legacy_deployment import P, legacy  # noqa: F401


async def test_original_web_bearer_can_read_and_save_but_never_borrows_another_realm(legacy, client, db):  # noqa: F811
    token = legacy.cookies['fire_session']
    headers = {'authorization':'Bearer '+token}
    assert (await legacy.get(P, headers=headers)).status_code == 200
    saved = await legacy.put(P+'/config',headers=headers,json={'request_id':str(uuid4()),'revision':None,'repository':'synthetic/alcor-api'})
    assert saved.status_code == 200, saved.text
    invalid = [{'authorization':''}, {'authorization':'Bearer '},
               [('authorization','Bearer '+token),('authorization','Bearer '+('0'*64))],
               {'authorization':'Bearer '+client.cookies[COOKIE]},
               {'authorization':'Bearer fat_'+('a'*43)}]
    for supplied in invalid:
        assert (await legacy.get(P,headers=supplied)).status_code == 403
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET client_id='legacy-v1' WHERE token_hash=%s",(digest(token),))
    assert (await legacy.get(P,headers=headers)).status_code == 403
