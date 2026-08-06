import type { Queryable } from "./postgres-runtime-identity";

interface IdentityRow { safe_runtime_identity: boolean }

/** Fail closed unless this is the isolated expiry-job login and pristine PG16 catalog. */
export function assertDowntownUJobRuntimeIdentity(queryable: Queryable): Promise<void> {
  return queryable.query<IdentityRow>(`
    WITH identity AS (
      SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER
    ), job_role AS (
      SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='downtown_u_jobs'
    ), runtime_role AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='downtown_u_runtime'),
    kitchen_role AS (
      SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='downtown_u_kitchen_jobs'
      UNION ALL
      SELECT NULL::oid,false,false,false,false,false,false
      WHERE pg_catalog.to_regclass('public.downtown_u_kitchen_order_outbox') IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='downtown_u_kitchen_jobs')
    ),
    trusted_owner AS (SELECT proowner AS oid FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.downtown_u_require_trusted_purchase_grant()')),
    downtown_relations AS (
      SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'downtown!_u!_%' ESCAPE '!' AND c.relkind IN('r','p','v','m','f','S')
        AND c.relname NOT LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!'
    ), downtown_functions AS (
      SELECT p.*,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
        AND p.proname NOT LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!'
    ), relation_topology AS (
      /* PG16-pinned, owner-portable descriptors for every Downtown relation.
       * ACL identities are semantic labels rather than cluster-local OIDs or the
       * migration owner's role name. Arrays whose ordering has no meaning are
       * sorted before hashing. */
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',c.relname,
        'relation',pg_catalog.jsonb_build_object(
          'kind',c.relkind,'owner_is_trusted',c.relowner=(SELECT oid FROM trusted_owner),
          'persistence',c.relpersistence,'rowsecurity',c.relrowsecurity,
          'forcerowsecurity',c.relforcerowsecurity,'replident',c.relreplident,
          'options',COALESCE((SELECT pg_catalog.jsonb_agg(o.option ORDER BY o.option COLLATE "C") FROM pg_catalog.unnest(c.reloptions) o(option)),'[]'::jsonb),
          'access_method',am.amname,'ispartition',c.relispartition,
          'partition_bound',CASE WHEN c.relpartbound IS NULL THEN NULL ELSE pg_catalog.pg_get_expr(c.relpartbound,c.oid,true) END),
        'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'attnum',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
          'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,true),
          'identity',a.attidentity,'generated',a.attgenerated,
          'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
            'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END,
            'privilege',z.privilege_type,'grantable',z.is_grantable)
            ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END) COLLATE "C",
              (CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END) COLLATE "C",z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
            FROM pg_catalog.aclexplode(a.attacl) z
            LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor))
          ORDER BY a.attnum),'[]'::jsonb) FROM pg_catalog.pg_attribute a
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'constraints',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',x.conname,'type',x.contype,'definition',pg_catalog.pg_get_constraintdef(x.oid,true)) ORDER BY x.conname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
        'indexes',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',i.relname,'definition',pg_catalog.pg_get_indexdef(i.oid,0,true),
          'predicate',pg_catalog.pg_get_expr(ix.indpred,ix.indrelid,true)) ORDER BY i.relname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid),
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
          'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END) COLLATE "C",
            (CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END) COLLATE "C",z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
          FROM pg_catalog.aclexplode(COALESCE(c.relacl,CASE WHEN c.relkind='S'
            THEN pg_catalog.acldefault('s',c.relowner) ELSE pg_catalog.acldefault('r',c.relowner) END)) z
          LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor),
        'inheritance_parents',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'schema',pn.nspname,'relation',p.relname,'sequence',h.inhseqno) ORDER BY h.inhseqno,pn.nspname COLLATE "C",p.relname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class p ON p.oid=h.inhparent
          JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace WHERE h.inhrelid=c.oid),
        'rules',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',r.rulename,'enabled',r.ev_enabled,'event',r.ev_type,'instead',r.is_instead,
          'definition',pg_catalog.pg_get_ruledef(r.oid,true)) ORDER BY r.rulename COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),
        'policies',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,
          'roles',COALESCE((SELECT pg_catalog.jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' WHEN role_oid=c.relowner THEN 'OWNER' ELSE pr.rolname END
            ORDER BY (CASE WHEN role_oid=0 THEN 'PUBLIC' WHEN role_oid=c.relowner THEN 'OWNER' ELSE pr.rolname END) COLLATE "C")
            FROM pg_catalog.unnest(p.polroles) role_oid LEFT JOIN pg_catalog.pg_roles pr ON pr.oid=role_oid),'[]'::jsonb),
          'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid,true),
          'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true)) ORDER BY p.polname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
        'triggers',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',t.tgname,'enabled',t.tgenabled,'definition',pg_catalog.pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
            AND t.tgname NOT LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!')
      ) ORDER BY c.relname COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash
      FROM downtown_relations c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    ), function_topology AS (
      /* PG16-pinned complete descriptors for every Downtown function. This is
       * deliberately wider than the executable job surface because expiry
       * inserts traverse the protected ledger trigger graph. */
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',p.proname,'identity_arguments',pg_catalog.oidvectortypes(p.proargtypes),
        'owner_is_trusted',p.proowner=(SELECT oid FROM trusted_owner),
        'prosrc',p.prosrc,'probin',p.probin,'result_type',pg_catalog.format_type(p.prorettype,NULL),
        'arg_types',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(x.type_oid,NULL) ORDER BY x.ordinality) FROM pg_catalog.unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[])) WITH ORDINALITY x(type_oid,ordinality)),'[]'::jsonb),
        'arg_modes',COALESCE(pg_catalog.to_jsonb(p.proargmodes),'[]'::jsonb),'arg_names',COALESCE(pg_catalog.to_jsonb(p.proargnames),'[]'::jsonb),
        'prokind',p.prokind,'returns_set',p.proretset,'input_count',p.pronargs,'volatility',p.provolatile,'strict',p.proisstrict,
        'security_definer',p.prosecdef,'leakproof',p.proleakproof,'parallel',p.proparallel,
        'support',CASE WHEN p.prosupport=0 THEN '-' ELSE p.prosupport::pg_catalog.regproc::text END,'cost',p.procost,'rows',p.prorows,'language',p.lanname,
        'config',COALESCE(pg_catalog.to_jsonb(p.proconfig),'[]'::jsonb),
        'transform_types',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(x.type_oid,NULL) ORDER BY x.ordinality) FROM pg_catalog.unnest(p.protrftypes) WITH ORDINALITY x(type_oid,ordinality)),'[]'::jsonb),
        'sql_body',COALESCE(pg_catalog.pg_get_expr(p.prosqlbody,0,true),''),'variadic_type',CASE WHEN p.provariadic=0 THEN '-' ELSE pg_catalog.format_type(p.provariadic,NULL) END,
        'argument_defaults',COALESCE(pg_catalog.pg_get_expr(p.proargdefaults,0,true),''),'default_count',p.pronargdefaults,
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN x.grantee=p.proowner THEN 'OWNER' WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END,
          'grantor_is_owner',x.grantor=p.proowner,'privilege',x.privilege_type,'grantable',x.is_grantable)
          ORDER BY (CASE WHEN x.grantee=p.proowner THEN 'OWNER' WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END) COLLATE "C",x.privilege_type COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee)
      ) ORDER BY p.proname COLLATE "C",pg_catalog.oidvectortypes(p.proargtypes) COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash FROM downtown_functions p
    ), nonowner_function_acls AS (
      /* Role/owner-portable exact ACL topology. Function descriptors above also
       * pin each ACL, while these rows state the least-privilege invariant
       * directly rather than depending on locale-sensitive aggregate hashing. */
      SELECT p.oid,p.proname,pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments,
        x.grantee,x.grantor,x.privilege_type,x.is_grantable
      FROM downtown_functions p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
      WHERE x.grantee<>p.proowner
    )
    SELECT COALESCE((SELECT i.rolcanlogin AND SESSION_USER=CURRENT_USER
      AND NOT i.rolsuper AND NOT i.rolcreatedb AND NOT i.rolcreaterole AND NOT i.rolreplication AND NOT i.rolbypassrls
      AND NOT j.rolcanlogin AND NOT j.rolsuper AND NOT j.rolcreatedb AND NOT j.rolcreaterole AND NOT j.rolreplication AND NOT j.rolbypassrls
      AND (k.oid IS NULL OR (NOT k.rolcanlogin AND NOT k.rolsuper AND NOT k.rolcreatedb AND NOT k.rolcreaterole AND NOT k.rolreplication AND NOT k.rolbypassrls))
      AND pg_catalog.pg_has_role(CURRENT_USER,j.oid,'MEMBER') AND NOT pg_catalog.pg_has_role(CURRENT_USER,r.oid,'MEMBER')
      AND NOT COALESCE(pg_catalog.pg_has_role(CURRENT_USER,k.oid,'MEMBER'),false)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        AND c.relname LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!' AND pg_catalog.has_table_privilege(CURRENT_USER,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND p.proname LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!' AND pg_catalog.has_function_privilege(CURRENT_USER,p.oid,'EXECUTE'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid NOT IN(i.oid,j.oid) AND pg_catalog.pg_has_role(CURRENT_USER,x.oid,'MEMBER'))
      AND NOT pg_catalog.has_schema_privilege(CURRENT_USER,'public','CREATE') AND NOT pg_catalog.has_database_privilege(CURRENT_USER,CURRENT_DATABASE(),'CREATE')
      AND (SELECT count(*) FROM trusted_owner)=1
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d WHERE d.relowner<>(SELECT oid FROM trusted_owner))
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d WHERE d.relkind<>'S'
        AND pg_catalog.has_table_privilege(CURRENT_USER,d.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d WHERE d.relkind='S'
        AND pg_catalog.has_sequence_privilege(CURRENT_USER,d.oid,'USAGE,SELECT,UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE d.relkind<>'S' AND pg_catalog.has_column_privilege(CURRENT_USER,d.oid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))
      AND NOT EXISTS (SELECT 1 FROM downtown_functions p WHERE p.proowner<>(SELECT oid FROM trusted_owner)
        OR pg_catalog.has_function_privilege(CURRENT_USER,p.oid,'EXECUTE')<>(p.oid=pg_catalog.to_regprocedure('public.downtown_u_reverse_expired_reservations(integer)')))
      AND (SELECT hash FROM relation_topology)='c2d3ce534b037caad8d471d8568267fe30f9313b57b7f3e7776d8e9dd90ee808'
      AND (SELECT hash FROM function_topology)='9bf00832a9440bedd5b4cee576651644972a9c8359ec80f752668d3cf4895240'
      AND NOT EXISTS (SELECT 1 FROM nonowner_function_acls a
        JOIN downtown_functions p ON p.oid=a.oid
        WHERE a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
          OR (p.proname='downtown_u_reverse_expired_reservations' AND a.grantee<>j.oid)
          OR (p.proname<>'downtown_u_reverse_expired_reservations' AND a.grantee<>r.oid))
      FROM identity i CROSS JOIN job_role j CROSS JOIN runtime_role r CROSS JOIN kitchen_role k),false) safe_runtime_identity
  `).then(result => {
    if (result.rows.length !== 1 || result.rows[0].safe_runtime_identity !== true) throw new Error("Unsafe Downtown U job database identity");
  });
}
