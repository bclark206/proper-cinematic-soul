import type { PoolClient } from "pg";

export type OperatorQueryable = Pick<PoolClient, "query">;

/** PG16 descriptors generated from pristine migrations 001-010; never learned at runtime. */
export const OPERATOR_RELATION_TOPOLOGY_SHA256 = "efdd8914954a65c8d68c2fbe5012039f74321cfc4b4640e4b5d44488c00dba94";
export const OPERATOR_CAPABILITY_TOPOLOGY_SHA256 = "1c79596947b0fe0fb19dc430f9104aed7283ee3108172a77aa465ab0d60b2777";
export const OPERATOR_DEPENDENCY_TOPOLOGY_SHA256 = "0f5c5b5c538342fdc983999b7e22d0dfc55ea81f33fc46e95b2e847b87042dbc";

interface IdentityRow { safe_operator_identity: boolean }

/**
 * Attest the checked-out connection and the complete operator capability boundary.
 * This must run inside the same short transaction as the subsequent capability call.
 */
export async function assertDowntownUOperatorRuntimeIdentity(queryable: OperatorQueryable): Promise<void> {
  const result = await queryable.query<IdentityRow>(`
    WITH RECURSIVE membership_closure(member,roleid) AS (
      SELECT m.member,m.roleid FROM pg_catalog.pg_auth_members m
      UNION
      SELECT m.member,n.roleid FROM membership_closure m
      JOIN pg_catalog.pg_auth_members n ON n.member=m.roleid
    ), identity AS (
      SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig
      FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER
    ), capability_role AS (
      SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig
      FROM pg_catalog.pg_roles WHERE rolname='downtown_u_operator_runtime'
    ), trusted_owner AS (
      SELECT p.proowner oid FROM pg_catalog.pg_proc p
      WHERE p.oid=pg_catalog.to_regprocedure('public.downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text)')
    ), downtown_relations AS (
      SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'downtown!_u!_%' ESCAPE '!'
        AND c.relkind IN ('r','p','v','m','f','S')
    ), operator_relations AS (
      SELECT c.* FROM downtown_relations c
      WHERE c.relname LIKE 'downtown!_u!_operator!_%' ESCAPE '!' OR c.relname='downtown_u_eligibility_events'
    ), downtown_functions AS (
      SELECT p.*,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
    ), expected_capabilities(signature) AS (VALUES
      ('downtown_u_operator_auth_begin(uuid,text,smallint,bytea,uuid,bytea,text)'),
      ('downtown_u_operator_auth_verify_email(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)'),
      ('downtown_u_operator_auth_finish_sign_in(uuid,smallint,bytea,uuid,smallint,bytea,uuid,smallint,bytea,text)'),
      ('downtown_u_operator_auth_validate_session(uuid,smallint,bytea,text,text,text)'),
      ('downtown_u_operator_auth_begin_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)'),
      ('downtown_u_operator_auth_finish_reauth(uuid,smallint,bytea,uuid,smallint,bytea,text)'),
      ('downtown_u_operator_auth_revoke_session(uuid,smallint,bytea,text)')
    ), capabilities AS (
      SELECT p.* FROM downtown_functions p JOIN expected_capabilities e
        ON p.oid=pg_catalog.to_regprocedure('public.'||e.signature)::oid
    ), executable_dependencies AS (
      SELECT p.* FROM downtown_functions p
      WHERE p.proname LIKE 'downtown!_u!_operator!_%' ESCAPE '!'
        AND NOT EXISTS (SELECT 1 FROM capabilities c WHERE c.oid=p.oid)
    ), relation_topology AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',c.relname,'relation',pg_catalog.jsonb_build_object(
          'kind',c.relkind,'owner_is_trusted',c.relowner=(SELECT oid FROM trusted_owner),
          'persistence',c.relpersistence,'rowsecurity',c.relrowsecurity,'forcerowsecurity',c.relforcerowsecurity,
          'replident',c.relreplident,'options',COALESCE((SELECT pg_catalog.jsonb_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(c.reloptions) o),'[]'::jsonb),
          'access_method',am.amname,'ispartition',c.relispartition,
          'partition_bound',CASE WHEN c.relpartbound IS NULL THEN NULL ELSE pg_catalog.pg_get_expr(c.relpartbound,c.oid,true) END),
        'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'attnum',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
          'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,true),'identity',a.attidentity,'generated',a.attgenerated,
          'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
            'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END,
            'privilege',z.privilege_type,'grantable',z.is_grantable)
            ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END) COLLATE "C",
              z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
            FROM pg_catalog.aclexplode(a.attacl) z LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor))
          ORDER BY a.attnum),'[]'::jsonb) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'constraints',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',x.conname,'type',x.contype,
          'definition',pg_catalog.pg_get_constraintdef(x.oid,true)) ORDER BY x.conname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
        'indexes',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',i.relname,
          'definition',pg_catalog.pg_get_indexdef(i.oid,0,true),'predicate',pg_catalog.pg_get_expr(ix.indpred,ix.indrelid,true)) ORDER BY i.relname COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid),
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
          'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' ELSE go.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END) COLLATE "C",z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
          FROM pg_catalog.aclexplode(COALESCE(c.relacl,CASE WHEN c.relkind='S' THEN pg_catalog.acldefault('s',c.relowner) ELSE pg_catalog.acldefault('r',c.relowner) END)) z
          LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor),
        'parents',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('schema',pn.nspname,'relation',p.relname,'sequence',h.inhseqno)
          ORDER BY h.inhseqno,pn.nspname COLLATE "C",p.relname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_inherits h
          JOIN pg_catalog.pg_class p ON p.oid=h.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace WHERE h.inhrelid=c.oid),
        'rules',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',r.rulename,'enabled',r.ev_enabled,'event',r.ev_type,
          'instead',r.is_instead,'definition',pg_catalog.pg_get_ruledef(r.oid,true)) ORDER BY r.rulename COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),
        'policies',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.polname,'permissive',p.polpermissive,
          'command',p.polcmd,'roles',p.polroles,'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid,true),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true))
          ORDER BY p.polname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
        'triggers',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
          'definition',pg_catalog.pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
      ) ORDER BY c.relname COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash
      FROM operator_relations c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    ), capability_topology AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',p.proname,'identity_arguments',pg_catalog.oidvectortypes(p.proargtypes),'owner_is_trusted',p.proowner=(SELECT oid FROM trusted_owner),
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
      ) ORDER BY p.proname COLLATE "C",pg_catalog.oidvectortypes(p.proargtypes) COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash FROM capabilities p
    ), dependency_topology AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',p.proname,'identity_arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
        'arg_types',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(x.type_oid,NULL) ORDER BY x.ordinality) FROM pg_catalog.unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[])) WITH ORDINALITY x(type_oid,ordinality)),'[]'::jsonb),
        'arg_modes',COALESCE(pg_catalog.to_jsonb(p.proargmodes),'[]'::jsonb),'arg_names',COALESCE(pg_catalog.to_jsonb(p.proargnames),'[]'::jsonb),
        'result_type',pg_catalog.format_type(p.prorettype,NULL),'returns_set',p.proretset,'prokind',p.prokind,'input_count',p.pronargs,
        'prosrc',p.prosrc,'probin',p.probin,'language',p.lanname,'owner_is_trusted',p.proowner=(SELECT oid FROM trusted_owner),
        'security_definer',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'leakproof',p.proleakproof,'parallel',p.proparallel,
        'config',COALESCE(pg_catalog.to_jsonb(p.proconfig),'[]'::jsonb),
        'argument_defaults',COALESCE(pg_catalog.pg_get_expr(p.proargdefaults,0,true),''),'default_count',p.pronargdefaults,
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN x.grantee=p.proowner THEN 'OWNER' WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END,
          'grantor_is_owner',x.grantor=p.proowner,'privilege',x.privilege_type,'grantable',x.is_grantable)
          ORDER BY (CASE WHEN x.grantee=p.proowner THEN 'OWNER' WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END) COLLATE "C",x.privilege_type COLLATE "C"),'[]'::jsonb)
          FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.grantee)
      ) ORDER BY p.proname COLLATE "C",pg_catalog.oidvectortypes(p.proargtypes) COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash
      FROM executable_dependencies p
    )
    SELECT COALESCE((SELECT
      SESSION_USER=CURRENT_USER AND i.rolcanlogin AND NOT i.rolsuper AND NOT i.rolcreatedb AND NOT i.rolcreaterole
      AND NOT i.rolreplication AND NOT i.rolbypassrls AND i.rolconfig IS NULL
      AND NOT c.rolcanlogin AND NOT c.rolsuper AND NOT c.rolcreatedb AND NOT c.rolcreaterole
      AND NOT c.rolreplication AND NOT c.rolbypassrls AND c.rolconfig IS NULL
      AND pg_catalog.pg_has_role(i.oid,c.oid,'MEMBER')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid NOT IN(i.oid,c.oid) AND pg_catalog.pg_has_role(i.oid,x.oid,'MEMBER'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid<>c.oid AND pg_catalog.pg_has_role(c.oid,x.oid,'MEMBER'))
      AND (SELECT count(*) FROM trusted_owner)=1
      AND NOT EXISTS (SELECT 1 FROM membership_closure m WHERE
        (m.member IN(i.oid,c.oid) AND m.roleid=(SELECT oid FROM trusted_owner))
        OR (m.member=(SELECT oid FROM trusted_owner) AND m.roleid IN(i.oid,c.oid)))
      AND pg_catalog.has_schema_privilege(i.oid,'public','USAGE') AND NOT pg_catalog.has_schema_privilege(i.oid,'public','CREATE')
      AND NOT pg_catalog.has_database_privilege(i.oid,CURRENT_DATABASE(),'CREATE')
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d WHERE d.relowner=i.oid OR pg_catalog.pg_has_role(i.oid,d.relowner,'MEMBER')
        OR (d.relkind='S' AND pg_catalog.has_sequence_privilege(i.oid,d.oid,'USAGE,SELECT,UPDATE'))
        OR (d.relkind<>'S' AND pg_catalog.has_table_privilege(i.oid,d.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND NOT EXISTS (SELECT 1 FROM downtown_relations d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE d.relkind<>'S' AND pg_catalog.has_column_privilege(i.oid,d.oid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))
      AND NOT EXISTS (SELECT 1 FROM downtown_functions p WHERE p.proowner=i.oid OR pg_catalog.pg_has_role(i.oid,p.proowner,'MEMBER')
        OR pg_catalog.has_function_privilege(i.oid,p.oid,'EXECUTE') <> EXISTS(SELECT 1 FROM capabilities a WHERE a.oid=p.oid))
      AND (SELECT count(*) FROM capabilities)=7
      AND (SELECT count(*) FROM executable_dependencies)=5
      AND NOT EXISTS (SELECT 1 FROM capabilities p WHERE p.proowner<>(SELECT oid FROM trusted_owner) OR p.lanname<>'plpgsql'
        OR NOT p.prosecdef OR p.proisstrict OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR p.pronargdefaults<>0)
      AND NOT EXISTS (SELECT 1 FROM capabilities p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE (a.grantee=p.proowner AND (a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
          OR (a.grantee<>p.proowner AND (a.grantee<>c.oid OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)))
      AND NOT EXISTS (SELECT 1 FROM capabilities p WHERE (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))))<>2)
      AND NOT EXISTS (SELECT 1 FROM executable_dependencies p WHERE p.proowner<>(SELECT oid FROM trusted_owner)
        OR p.lanname<>'plpgsql' OR NOT p.prosecdef OR p.proisstrict
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR p.pronargdefaults<>0
        OR (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))))<>1
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
      AND NOT EXISTS (SELECT 1 FROM operator_relations d WHERE d.relowner<>(SELECT oid FROM trusted_owner))
      AND (SELECT hash FROM relation_topology)='${OPERATOR_RELATION_TOPOLOGY_SHA256}'
      AND (SELECT hash FROM capability_topology)='${OPERATOR_CAPABILITY_TOPOLOGY_SHA256}'
      AND (SELECT hash FROM dependency_topology)='${OPERATOR_DEPENDENCY_TOPOLOGY_SHA256}'
      FROM identity i CROSS JOIN capability_role c),false) safe_operator_identity
  `);
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0].safe_operator_identity !== true) {
    throw new Error("Unsafe Downtown U operator database identity");
  }
}
