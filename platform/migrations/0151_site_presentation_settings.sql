-- Extend only the existing explicit public/presentation key boundary.
-- Revision, singleton and operation/original immutability constraints remain intact.
DO $$
DECLARE candidate record;matches integer:=0;selected_name text;literal text;
BEGIN
 FOR candidate IN SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
   WHERE c.conrelid='site_settings'::regclass AND c.contype='c'
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='site_settings'::regclass AND attname='settings')]::smallint[]
 LOOP
  IF position('jsonb_typeof(settings)' in candidate.definition)>0 AND position('ARRAY[' in candidate.definition)>0 THEN
   FOR literal IN SELECT value[1] FROM regexp_matches(candidate.definition,'''([^'']*)''','g') value LOOP
    IF NOT literal=ANY(ARRAY['object','title','ico','homepageBg','loginSideImage','domain','siteLogo','logoText','logoFont','footerDesc','homeNav','marketBadges','marketBadgesVisible','{}'])
    THEN RAISE EXCEPTION 'site settings original check differs from reviewed 0085 boundary'; END IF;
   END LOOP;
   matches:=matches+1;selected_name:=candidate.conname;
  END IF;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION 'expected one reviewed site settings key boundary'; END IF;
 EXECUTE format('ALTER TABLE site_settings DROP CONSTRAINT %I',selected_name);
END $$;
ALTER TABLE site_settings ADD CONSTRAINT site_settings_check CHECK(
 jsonb_typeof(settings)='object' AND settings-ARRAY['appDisplayIcon','appDisplayName','assetAnalysisOrder','assetMarketOrder','domain','footerDesc','holdingColumns','homeNav','homepageBg','ico','indicesOrder','loginSideImage','logoFont','logoText','marketBadges','marketBadgesVisible','marketLabels','markets','mobileNavigationOrder','pwaIcon','siteLogo','stockIconCdn','tabs','title']='{}'::jsonb);
