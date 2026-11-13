"""Licensed immutable chart observations, window coverage and original page access. No IO."""
import hashlib
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .market_contract import CURRENCIES, ZONES, code, digest
from .market_history_evidence import bounded_history_read, load_history_evidence, verify_history_evidence
from .market_history_reads import LicensedHistory
from .security import lock_mutation_identity


class HistoryService(LicensedHistory):
    async def authorize(self, conn, who):
        await lock_mutation_identity(conn, who, require_admin=False)
        actor = await (await conn.execute('SELECT role FROM users WHERE id=%s', (who.id,))).fetchone()
        if not actor or actor['role'] != who.role:
            raise HTTPException(403, '读取身份或权限已变化')

    @bounded_history_read
    async def read_chart(self, who, market, symbol, *, frame='day', adjust='none', session='REGULAR', instrument='equity',
                         kind='bars', mode='bars', source_revision=None, start=None, through=None, limit=3000,
                         before=None, expected_revision=None):
        try:
            symbol = code(market, symbol)
            revision = UUID(str(source_revision)) if source_revision is not None else None
            zone = ZoneInfo(ZONES[market])
            begin = datetime.combine(date.fromisoformat(start), time.min, zone) if start else None
            end = datetime.combine(date.fromisoformat(through)+timedelta(days=1), time.min, zone) if through else None
            prior = datetime.fromisoformat(before) if before else None
            if (frame not in ('minute','day','week','month','quarter','year') or adjust not in ('none','qfq','hfq')
                    or kind not in ('bars','price_series') or kind=='price_series' and (frame!='minute' or adjust!='none')
                    or session not in ('REGULAR','ALL') or instrument not in ('equity','index','asset')
                    or mode not in ('bars','all-day','five-day') or mode!='bars' and frame!='minute'
                    or begin and end and begin>=end or prior and prior.tzinfo is None
                    or type(limit) is not int or not 1<=limit<=12000
                    or expected_revision is not None and (len(expected_revision)!=64 or any(c not in '0123456789abcdef' for c in expected_revision))
                    or before is not None and expected_revision is None):
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise HTTPException(400, '历史窗口、口径、来源或续页参数无效') from None
        requested = {'kind':kind,'market':market,'code':symbol,'frame':frame,'adjust':adjust,'session':session,
                     'instrument':instrument,'mode':mode,'start':start,'through':through}
        requested_revision = revision
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await self.authorize(conn, who)
            choices, retained = await self.choices(conn, who.id, market, symbol, frame=frame, adjust=adjust,
                                                   instrument=instrument, session=session, kind=kind, revision=revision)
            if len(choices)>1:
                raise HTTPException(409, '存在多个真实来源，请明确来源版本')
            if not choices:
                return {'query':requested,'sourceRevision':str(revision) if revision else None,'revision':None,'licenseRevision':None,
                        'timezone':ZONES[market],'facts':[],'indicators':None,'state':'retained_unavailable' if retained else 'unknown',
                        'coverage':{'assurance':'unknown','windows':[],'fullBusinessHistoryVerified':False},
                        'availableRange':{'from':None,'through':None,'observedLocalDates':[]},
                        'pagination':{'before':None,'hasMore':False},'retainedSources':retained,'automaticCollection':False}
            (revision, series), (policy, _query) = next(iter(choices.items()))
            head = await (await conn.execute('SELECT max(sequence) AS head,count(*) AS versions,min(source_time) AS first,max(source_time) AS last FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s', (who.id, revision, series))).fetchone()
            coverage = await (await conn.execute("""SELECT c.* FROM market_coverage_receipts c JOIN market_streams s ON s.owner_id=c.owner_id AND s.id=c.stream_id
                WHERE s.owner_id=%s AND s.source_revision=%s AND s.query->>'kind'=%s AND s.query->>'frame'=%s
                AND s.query->>'market'=%s AND s.query->>'code'=%s AND s.query->>'adjust'=%s AND s.query->>'session'=%s AND s.query->>'instrument'=%s
                ORDER BY c.created_at DESC,c.task_id DESC LIMIT 1001""", (who.id,revision,kind,frame,market,symbol,adjust,session,instrument))).fetchall()
            current = digest({'source':str(revision),'series':series,'head':head['head'],'versions':head['versions'],
                              'coverage':[str(row['task_id']) for row in coverage]})
            if expected_revision is not None and expected_revision!=current:
                raise HTTPException(409, '历史事实或覆盖版本已变化，请从第一页重读')
            selected_dates = []
            if mode!='bars':
                dates = await (await conn.execute('SELECT DISTINCT (source_time AT TIME ZONE %s)::date AS day FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s AND (%s::timestamptz IS NULL OR source_time>=%s) AND (%s::timestamptz IS NULL OR source_time<%s) ORDER BY day DESC LIMIT %s', (ZONES[market],who.id,revision,series,begin,begin,end,end,5 if mode=='five-day' else 1))).fetchall()
                selected_dates = [row['day'].isoformat() for row in reversed(dates)]
            rows = await (await conn.execute('''SELECT * FROM (SELECT DISTINCT ON(source_time) * FROM market_facts
                WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s
                AND (%s::timestamptz IS NULL OR source_time>=%s) AND (%s::timestamptz IS NULL OR source_time<%s)
                AND (%s::timestamptz IS NULL OR source_time<%s)
                AND (%s OR (source_time AT TIME ZONE %s)::date=ANY(%s::date[]))
                ORDER BY source_time DESC,sequence DESC) latest ORDER BY source_time DESC LIMIT %s''',
                (who.id,revision,series,begin,begin,end,end,prior,prior,mode=='bars',ZONES[market],selected_dates,limit+1))).fetchall()
            more = len(rows)>limit
            rows = list(reversed(rows[:limit]))
            evidence = await load_history_evidence(conn, who.id, revision, rows)
        await verify_history_evidence(who.id, revision, evidence, policy)
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            selected, _ = await self.choices(conn, who.id, market, symbol, frame=frame, adjust=adjust,
                instrument=instrument, session=session, kind=kind, revision=requested_revision)
            if len(selected) > 1:
                raise HTTPException(409, '存在多个真实来源，请明确来源版本')
            candidate = selected.get((revision, series)) if len(selected) == 1 else None
            if candidate is None or candidate[0].fingerprint != policy.fingerprint:
                raise HTTPException(403, '历史来源展示许可或口径已变化，请撤下旧数据')
        facts = []
        now = self.authority.clock() if self.authority.clock else datetime.now(UTC)
        for row in rows:
            value = row['contents']
            try:
                stamp = datetime.fromisoformat(value['at'])
                if (stamp.tzinfo is None or stamp!=row['source_time'] or stamp>now+timedelta(seconds=5)
                        or value.get('source')!=policy.source or value.get('sourceVersion')!=policy.source_version
                        or value.get('currency')!=CURRENCIES[market] or value.get('session')!=session):
                    raise ValueError()
            except (ValueError, TypeError, KeyError):
                raise HTTPException(503, '真实历史事实的来源、时间或口径无法核对') from None
            facts.append({**value,'factId':str(row['id']),'pageId':str(row['page_id']),'revision':row['sequence']})
        windows = [{'from':row['window_from'].isoformat(),'through':row['window_through'].isoformat(),
                    'assurance':row['assurance'],'pointCount':row['point_count'],'taskId':str(row['task_id']),
                    'pageIds':[str(value) for value in row['page_ids']]} for row in coverage[:1000]]
        from .market_indicators import calculate_indicators
        indicators = calculate_indicators(facts,price_field='price' if kind=='price_series' else 'c')
        if indicators is not None:
            indicators['windowScope'] = 'returned_page_only'
        return {'query':requested,'sourceRevision':str(revision),'revision':current,'licenseRevision':policy.license_revision,
                'timezone':ZONES[market],'facts':facts,'state':'observed' if facts else 'unknown','indicators':indicators,
                'coverage':{'assurance':windows[0]['assurance'] if windows else 'unknown','windows':windows,
                            'windowListPartial':len(coverage)>1000,'fullBusinessHistoryVerified':False,'assuranceScope':'individual_recorded_windows_only',
                            'requestedObservedDates':5 if mode=='five-day' else 1 if mode=='all-day' else None,
                            'observedDateCount':len(selected_dates) if mode!='bars' else None,
                            'partial':more or not windows or kind=='price_series' or any('_partial_records' in row['assurance'] for row in windows) or mode=='five-day' and len(selected_dates)<5,
                            'calendarCompletenessVerified':False,'corporateActionContinuityVerified':False,'missingPointsFilled':False},
                'availableRange':{'from':head['first'].isoformat() if head['first'] else None,'through':head['last'].isoformat() if head['last'] else None,
                                  'observedLocalDates':selected_dates},
                'windowBasis':'observed_market_local_dates','pagination':{'before':rows[0]['source_time'].isoformat() if more and rows else None,'hasMore':more},
                'retainedSources':retained,'automaticCollection':False}

    async def original(self, who, page_id, revision):
        try:
            page_id, revision = UUID(str(page_id)), UUID(str(revision))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, '原件或来源版本无效') from None
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            await self.authority.config(conn, who.id, revision)
            page = await (await conn.execute('SELECT * FROM market_source_pages WHERE owner_id=%s AND id=%s AND source_revision=%s', (who.id,page_id,revision))).fetchone()
            if not page:
                raise HTTPException(404, '本人历史来源原件不存在')
            raw = bytes(page['raw_bytes'])
            if hashlib.sha256(raw).hexdigest()!=page['raw_sha256']:
                raise HTTPException(503, '历史原件校验失败')
            return raw, page['raw_sha256'], page['representation']
