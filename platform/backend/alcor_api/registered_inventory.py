"""Read-only account association from a verified existing registered baseline.

A nonfilled source intent can be shown under its associated account. The raw
payload stays unchanged; no source fill receives an actual financial mapping.
"""
async def overlay_registered_accounts(conn,owner,head,orders):
    if not head:return head,orders
    claims=await(await conn.execute("SELECT b.source_account_id,b.account_id FROM legacy_fee_source_account_bindings b JOIN legacy_source_heads h ON h.owner_id=b.owner_id JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id JOIN legacy_source_view_bindings v ON v.owner_id=m.owner_id AND v.manifest_id=m.id AND v.view_kind='fees' AND v.view_sha256=%s WHERE b.owner_id=%s AND b.source_instance=m.manifest->'source'->>'instance' AND b.source_owner=m.manifest->'source'->>'owner'",(head['source_digest'],owner))).fetchall()
    mapping={row['source_account_id']:row['account_id'] for row in claims}
    result=[]
    for item in orders:
        row=dict(item)
        if row['payload']['status']!='filled' and row['mapped_broker_id'] is None and row['original_broker_id'] in mapping:
            row.update(mapped_broker_id=mapping[row['original_broker_id']],associationBasis='existing_registered_baseline',financialApplied=False)
        result.append(row)
    return head,result
