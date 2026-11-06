"""Public SEC adapters reuse the existing directory and document projections."""

from types import SimpleNamespace

from fastapi import HTTPException

from .sec_company_service import CompanyProfiles
from .sec_company_transport import PageFailure, Transport
from .sec_financial_service import FinancialStatements


class PublicSecAdapter:
    def __init__(self,db,kind,*,targets=(),target_provider=None,transport=None):
        self.kind=kind
        self.domain=CompanyProfiles(SimpleNamespace(db=db)) if kind=='company-profile' else FinancialStatements(SimpleNamespace(db=db))
        self.source_version=self.domain.source_version
        self.targets,self.target_provider,self.transport=tuple(targets),target_provider,transport or Transport()

    def normalize(self,raw,collect=False):
        try:
            if not isinstance(raw,dict) or set(raw)-{'market','code'}:raise ValueError()
            market=raw.get('market','US')
            if market!='US':raise ValueError()
            return {'market':market,'code':self.domain.normalize_code(raw['code'])}
        except (KeyError,ValueError,TypeError):raise HTTPException(400,'公开SEC资料市场或证券参数无效') from None

    def scope(self,query):return dict(query)

    def target(self,policy):
        values=self.target_provider() if self.target_provider else self.targets
        targets=[]
        for raw in values:
            if isinstance(raw,dict):
                if raw.get('kind')!=self.kind:continue
                raw={key:value for key,value in raw.items() if key!='kind'}
                target=self.domain.target_type(**raw)
            else:target=raw
            if target.id==policy.target_id:targets.append(target)
        if len(targets)!=1 or targets[0].fingerprint!=policy.target_fingerprint:
            raise HTTPException(503,'公开SEC固定目标尚未独立安装')
        return targets[0].validate()

    def validate(self,policy,target,query):
        if policy.kind!=self.kind or policy.source_version!=self.source_version or query['market']!='US' or query['code'] not in policy.codes:
            raise HTTPException(403,'公开SEC证券用途未明确许可')

    async def acquire(self,target,query,*,before_request=None):
        symbol=query['code'];entry=self.domain.known_entry(symbol);cik=entry['cik'] if entry else None
        pages=[]
        for kind in ((self.domain.document_kind,) if entry else ('directory',self.domain.document_kind)):
            try:
                if before_request is not None:await before_request()
                raw=await self.transport.read(target,cik)
                pages.append({'kind':kind,'raw':raw,'status':200,'complete':True})
                if kind=='directory':
                    entry=self.domain.directory_entry(raw,symbol)
                    if entry is None:return pages
                    cik=entry['cik']
            except PageFailure as error:
                pages.append({'kind':kind,'raw':error.raw,'status':error.status,'complete':error.complete})
                return pages
            except Exception:
                if pages:return pages
                raise
        return pages

    def project(self,pages,query):
        if not 1<=len(pages)<=2 or any(not page['complete'] or page['status']!=200 for page in pages):raise ValueError('public_sec_incomplete')
        symbol=query['code'];directories=[page for page in pages if page['kind']=='directory']
        entry=self.domain.directory_entry(directories[0]['raw'],symbol) if len(directories)==1 else self.domain.known_entry(symbol)
        if not entry:
            if len(pages)==1 and directories:return {'state':'not_found_in_directory','market':'US','code':symbol}
            raise ValueError('public_sec_directory_missing')
        documents=[page for page in pages if page['kind']==self.domain.document_kind]
        if len(documents)!=1:raise ValueError('public_sec_document_missing')
        return {'state':'observed','market':'US','code':symbol,'profile':self.domain.project_document(documents[0]['raw'],entry,symbol)}

    def combine(self,observations,query):
        last=observations[-1]
        if last['payload']['state']=='not_found_in_directory':raise HTTPException(404,'未找到公开SEC公司档案')
        profile=last['payload']['profile']
        return {**profile,'migration':{**profile.get('migration',{}),'authority':'independently_licensed_public_sec',
            'licenseRevision':last['licenseRevision'],'observedAt':last['observedAt'],'collectionOnRead':False,
            'sourceTimeKnown':False,'originalsPubliclyAccessible':False}}
