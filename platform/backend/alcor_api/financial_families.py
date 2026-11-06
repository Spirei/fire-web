"""Structure evidence never claims that unexported financial families are empty.

Catalog discovery inspects names/types only. The source snapshot separately
marks allowlisted financing policy rows that it actually captured. Neither a missing table nor insufficient privileges proves a zero book.
"""

LISTED_SCOPE='legacy_portfolio_trade_and_fund_cash_tables'
FAMILY_LOCATIONS={
    'cards':{'card_amounts':None,'card_holdings':None,'card_details':None,'custom_cards':None,'card_balance_history':None},
    'simple_ledger':{'user_settings':('simple',)},
    'financing':{'account_financing_policy':None,'account_financing_requests':None},
}
FAMILY_TABLES=tuple(sorted({table for locations in FAMILY_LOCATIONS.values() for table in locations}))


def structure_evidence(catalog,*,method,known=True):
    """catalog maps visible table names to columns; None means no evidence."""
    return {'version':1,'method':method,'schemaInventoryKnown':known,'dataRowsRead':False,
            'tables':{name:{'observed':name in catalog if known else None,
                            'columns':catalog.get(name,[]) if known else None,
                            'dataRowsRead':False} for name in FAMILY_TABLES}}


def family_coverage(evidence=None):
    # This exporter has no authority to close any of these families. In
    # particular, absence of a known physical representation is not an owner
    # assertion that their family balance is zero or that no other store exists.
    known=isinstance(evidence,dict) and evidence.get('schemaInventoryKnown') is True
    families=[]
    for name,locations in FAMILY_LOCATIONS.items():
        refs=[]
        for table,columns in locations.items():
            observed=(evidence.get('tables',{}).get(table,{}) if isinstance(evidence,dict) else {})
            refs.append({'table':table,'requiredColumns':list(columns) if columns else None,
                         'observed':observed.get('observed'),
                         'columns':observed.get('columns'),
                         'dataRowsRead':observed.get('dataRowsRead') is True})
        families.append({'family':name,'state':'unknown','reason':'financial_family_debt_authority_not_verified' if name=='financing' and any(ref['dataRowsRead'] for ref in refs) else 'financial_family_not_exported',
                         'schemaEvidenceKnown':known,'locations':refs,
                         'accountKind':None,'currency':None,'amount':None})
    return {'scope':LISTED_SCOPE,'wholeLegacyFinancialComplete':False,
            'schemaEvidenceKnown':known,'unresolvedFamilies':families}


def captured_family_evidence(evidence,tables):
    import copy
    value=copy.deepcopy(evidence)
    for name,entry in value.get('tables',{}).items():
        captured=tables.get(name)
        entry['dataRowsRead']=bool(captured and captured.get('present'))
        if entry['dataRowsRead']:entry['observed']=True
    value['dataRowsRead']=any(entry.get('dataRowsRead') for entry in value.get('tables',{}).values())
    return value
