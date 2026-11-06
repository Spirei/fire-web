"""Presentation declarations cannot manufacture public data authority."""
from alcor_api.legacy_settings_domains import merge_ticker,ticker_declaration

def test_ticker_same_identity_retains_authority_but_retarget_is_unknown():
    old={'items':[{'key':'spx','market':'US','legacySecid':'100.SPX','publicDisplay':True,'sourceRevision':'declared-source','licenseRevision':'real-license'}]}
    declared=ticker_declaration({'items':[{'key':'spx','market':'US','secid':'100.SPX','label':'S&P'}],'interval':5})
    same=merge_ticker(old,declared)
    assert same['items'][0]['sourceRevision']=='declared-source'
    assert same['interval']==5000 and same['legacyPresentation']==declared
    declared['items'][0]['secid']='100.OTHER'
    changed=merge_ticker(old,declared)
    assert changed['items'][0]['publicDisplay'] is False
    assert 'sourceRevision' not in changed['items'][0]
    assert old['items'][0]['sourceRevision']=='declared-source'

def test_empty_or_unknown_ticker_never_installs_default_indices():
    assert ticker_declaration({'items':[],'interval':5}) is None
    declared=ticker_declaration({'items':[{'key':'new','secid':'100.SPX','label':'Declared','market':'US'}],'interval':300})
    result=merge_ticker({},declared)
    assert result['interval']==60000 and result['items'][0]['publicDisplay'] is False
    assert result['items'][0]['missing']=='explicit_public_source_identity_not_installed'
