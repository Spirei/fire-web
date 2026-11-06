ALTER TABLE asset_catalog_entries DROP CONSTRAINT asset_catalog_entries_type_check;
ALTER TABLE asset_catalog_entries ADD CONSTRAINT asset_catalog_entries_type_check
 CHECK(type IN ('stock','market','flag','crypto','metal','broker','group','icon'));
