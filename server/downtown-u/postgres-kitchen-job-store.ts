import type { Pool, PoolClient } from "pg";
import { withPostgresTransaction } from "./postgres-transaction";

export type KitchenAction = "create" | "cancel";
export interface KitchenClaim {
  leaseToken: string; action: KitchenAction; redemptionId: string; locationId: string; referenceId: string; idempotencyKey: string;
  mealName: string; mealCatalogObjectId: string; modifiers: unknown[]; squareOrderId: string | null; squareOrderVersion: number | null;
}
export interface KitchenObservedOrder { id: string; version: number }
interface Identity { safe: boolean; relation_hash: string; function_hash: string; host_trigger_hash: string; environment_hash: string }
// Reviewed from a pristine owner-portable migration 001-008 catalog on stock PostgreSQL 16.14.
const RELATION_HASH = "9e7d39e5432bc3ef979b006d10fa0d972068ecbc3eb8cc7034ace6acce7c7238";
const FUNCTION_HASH = "b45615271c9ef39d5e1475bb32923133cce7074a7c648eb16ea8405f629dacf6";
const HOST_TRIGGER_HASH = "d39d61c38264934c983daa5019031d4fc47f02eff4f52bba30a009176a1b0830";
const ENVIRONMENT_HASH = "bb686085e8313f169a6e9a690542cfcad1b13cd9b9ba86b833f179bd9ee88d2c";

/**
 * Fail closed unless this is the isolated kitchen login and the complete, owner-portable
 * stock-PG16 kitchen catalog/ACL topology created by migration 008. This runs in every
 * short database transaction; no transaction survives a provider request.
 */
export async function assertDowntownUKitchenJobIdentity(q: { query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> }): Promise<void> {
  const result = await q.query<Identity>(`
    WITH me AS (
      SELECT r.* FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER
    ), kitchen_role AS (
      SELECT r.* FROM pg_catalog.pg_roles r WHERE r.rolname='downtown_u_kitchen_jobs'
    ), runtime_role AS (
      SELECT r.* FROM pg_catalog.pg_roles r WHERE r.rolname='downtown_u_runtime'
    ), job_role AS (
      SELECT r.* FROM pg_catalog.pg_roles r WHERE r.rolname='downtown_u_jobs'
    ), trusted_owner AS (
      SELECT p.proowner oid FROM pg_catalog.pg_proc p
      WHERE p.oid=pg_catalog.to_regprocedure('public.downtown_u_kitchen_claim(integer)')
    ), kitchen_relations AS (
      SELECT c.*,n.nspname,am.amname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
      WHERE n.nspname='public' AND c.relname LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!'
        AND c.relkind IN ('r','p','v','m','f','S')
    ), all_downtown_relations AS (
      SELECT c.oid,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'downtown!_u!_%' ESCAPE '!'
        AND c.relkind IN ('r','p','v','m','f','S')
    ), kitchen_functions AS (
      SELECT p.*,n.nspname,l.lanname FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND p.proname LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!'
    ), all_downtown_functions AS (
      SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'downtown!_u!_%' ESCAPE '!'
    ), kitchen_host_triggers AS (
      /* Runtime/job preflights deliberately exclude kitchen-prefixed attachments.
       * Search the whole database, not merely the expected public host tables, so
       * moved, redirected, or additional SECURITY DEFINER attachments fail closed.
       * Triggers local to the two kitchen relations are already relation-hashed. */
      SELECT t.*,n.nspname AS host_schema,c.relname AS host_relation,p.proowner,p.prosecdef,p.proconfig,
        p.oid::pg_catalog.regprocedure::text AS function_signature
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND (
        t.tgfoid IN (pg_catalog.to_regprocedure('public.downtown_u_kitchen_enqueue()'),
          pg_catalog.to_regprocedure('public.downtown_u_kitchen_redemption_cancelled()'))
        OR (t.tgname LIKE 'downtown!_u!_kitchen!_%' ESCAPE '!'
          AND t.tgrelid NOT IN (pg_catalog.to_regclass('public.downtown_u_kitchen_config'),
            pg_catalog.to_regclass('public.downtown_u_kitchen_order_outbox'))))
    ), relation_descriptor AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',c.relname,'kind',c.relkind,'owner',c.relowner=(SELECT oid FROM trusted_owner),
        'persistence',c.relpersistence,'rowsecurity',c.relrowsecurity,'forcerowsecurity',c.relforcerowsecurity,
        'replident',c.relreplident,'options',COALESCE(pg_catalog.to_jsonb(c.reloptions),'[]'::jsonb),
        'access_method',c.amname,'ispartition',c.relispartition,
        'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'number',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
          'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,true),
          'identity',a.attidentity,'generated',a.attgenerated,
          'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END,
            'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END,
            'privilege',z.privilege_type,'grantable',z.is_grantable)
            ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC'
              WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END) COLLATE "C",
              (CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC'
              WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END) COLLATE "C",
              z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
            FROM pg_catalog.aclexplode(a.attacl) z LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor))
          ORDER BY a.attnum),'[]'::jsonb) FROM pg_catalog.pg_attribute a
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'constraints',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',x.conname,'type',x.contype,'definition',pg_catalog.pg_get_constraintdef(x.oid,true),
          'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred)
          ORDER BY x.conname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
        'indexes',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',i.relname,'definition',pg_catalog.pg_get_indexdef(i.oid,0,true),
          'predicate',pg_catalog.pg_get_expr(ix.indpred,ix.indrelid,true),'valid',ix.indisvalid,'ready',ix.indisready)
          ORDER BY i.relname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid),
        'triggers',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name',t.tgname,'enabled',t.tgenabled,'definition',pg_catalog.pg_get_triggerdef(t.oid,true),
          'function',t.tgfoid::pg_catalog.regprocedure::text,'arguments',pg_catalog.encode(t.tgargs,'hex'))
          ORDER BY t.tgname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
        'policies',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.polname COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
        'rules',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.pg_get_ruledef(r.oid,true) ORDER BY r.rulename COLLATE "C"),'[]'::jsonb) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END,
          'grantor',CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=c.relowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END) COLLATE "C",
            (CASE WHEN z.grantor=c.relowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END) COLLATE "C",
            z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb)
          FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) z
          LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor)
      ) ORDER BY c.relname COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') relation_hash FROM kitchen_relations c
    ), function_descriptor AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',p.proname,'arguments',pg_catalog.oidvectortypes(p.proargtypes),'owner',p.proowner=(SELECT oid FROM trusted_owner),
        'source',p.prosrc,'binary',p.probin,'result',pg_catalog.format_type(p.prorettype,NULL),
        'all_arguments',COALESCE(pg_catalog.to_jsonb(p.proallargtypes),'[]'::jsonb),'modes',COALESCE(pg_catalog.to_jsonb(p.proargmodes),'[]'::jsonb),
        'names',COALESCE(pg_catalog.to_jsonb(p.proargnames),'[]'::jsonb),'kind',p.prokind,'set',p.proretset,
        'input_count',p.pronargs,'volatility',p.provolatile,'strict',p.proisstrict,'security_definer',p.prosecdef,
        'leakproof',p.proleakproof,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows,'language',p.lanname,
        'config',COALESCE(pg_catalog.to_jsonb(p.proconfig),'[]'::jsonb),'defaults',COALESCE(pg_catalog.pg_get_expr(p.proargdefaults,0,true),''),'default_count',p.pronargdefaults,
        'acl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=p.proowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END,
          'grantor',CASE WHEN z.grantor=p.proowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=p.proowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE gr.rolname END) COLLATE "C",
            (CASE WHEN z.grantor=p.proowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE go.rolname END) COLLATE "C",
            z.privilege_type COLLATE "C",z.is_grantable),'[]'::jsonb) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) z
          LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=z.grantee LEFT JOIN pg_catalog.pg_roles go ON go.oid=z.grantor)
      ) ORDER BY p.proname COLLATE "C",pg_catalog.oidvectortypes(p.proargtypes) COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') function_hash FROM kitchen_functions p
    ), host_trigger_descriptor AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'host_schema',t.host_schema,'host_relation',t.host_relation,
        'name',t.tgname,'enabled',t.tgenabled,'type',t.tgtype,'argument_count',t.tgnargs,
        'arguments',pg_catalog.encode(t.tgargs,'hex'),'definition',pg_catalog.pg_get_triggerdef(t.oid,true),
        'function_oid_matches',CASE WHEN t.host_schema='public' AND t.host_relation='downtown_u_reservation_snapshots'
          THEN t.tgfoid=pg_catalog.to_regprocedure('public.downtown_u_kitchen_enqueue()')
          WHEN t.host_schema='public' AND t.host_relation='downtown_u_redemptions'
          THEN t.tgfoid=pg_catalog.to_regprocedure('public.downtown_u_kitchen_redemption_cancelled()') ELSE false END,
        'function_signature',t.function_signature,
        'function_owner',t.proowner=(SELECT oid FROM trusted_owner),'security_definer',t.prosecdef,
        'security_config',COALESCE(pg_catalog.to_jsonb(t.proconfig),'[]'::jsonb))
        ORDER BY t.host_schema COLLATE "C",t.host_relation COLLATE "C",t.tgname COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') host_trigger_hash
      FROM kitchen_host_triggers t
    ), environment_descriptor AS (
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'schema_acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=n.nspowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE r.rolname END,
          'grantor',CASE WHEN z.grantor=n.nspowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE g.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=n.nspowner THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE r.rolname END) COLLATE "C",
            (CASE WHEN z.grantor=n.nspowner THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE g.rolname END) COLLATE "C",
            z.privilege_type COLLATE "C",z.is_grantable) FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) z
          LEFT JOIN pg_catalog.pg_roles r ON r.oid=z.grantee LEFT JOIN pg_catalog.pg_roles g ON g.oid=z.grantor WHERE n.nspname='public'),
        'database_acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee',CASE WHEN z.grantee=d.datdba THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE r.rolname END,
          'grantor',CASE WHEN z.grantor=d.datdba THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE g.rolname END,
          'privilege',z.privilege_type,'grantable',z.is_grantable)
          ORDER BY (CASE WHEN z.grantee=d.datdba THEN 'OWNER' WHEN z.grantee=0 THEN 'PUBLIC' WHEN z.grantee=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE r.rolname END) COLLATE "C",
            (CASE WHEN z.grantor=d.datdba THEN 'OWNER' WHEN z.grantor=0 THEN 'PUBLIC' WHEN z.grantor=(SELECT oid FROM kitchen_role) THEN 'KITCHEN' ELSE g.rolname END) COLLATE "C",
            z.privilege_type COLLATE "C",z.is_grantable) FROM pg_catalog.pg_database d
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) z
          LEFT JOIN pg_catalog.pg_roles r ON r.oid=z.grantee LEFT JOIN pg_catalog.pg_roles g ON g.oid=z.grantor WHERE d.datname=pg_catalog.current_database())
      )::text,'UTF8')),'hex') environment_hash
    )
    SELECT COALESCE((SELECT
      pg_catalog.current_setting('server_version_num')::integer BETWEEN 160000 AND 169999
      AND SESSION_USER=CURRENT_USER
      AND m.rolcanlogin AND NOT m.rolsuper AND NOT m.rolcreatedb AND NOT m.rolcreaterole AND NOT m.rolreplication AND NOT m.rolbypassrls
      AND NOT k.rolcanlogin AND NOT k.rolsuper AND NOT k.rolcreatedb AND NOT k.rolcreaterole AND NOT k.rolreplication AND NOT k.rolbypassrls
      AND NOT r.rolcanlogin AND NOT j.rolcanlogin
      AND (SELECT count(*) FROM trusted_owner)=1
      AND (SELECT count(*) FROM kitchen_relations)=2
      AND (SELECT count(*) FROM kitchen_functions)=6
      AND (SELECT count(*) FROM kitchen_host_triggers)=2
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a WHERE a.member=m.oid AND a.roleid<>k.oid)
      AND (SELECT count(*) FROM pg_catalog.pg_auth_members a WHERE a.member=m.oid AND a.roleid=k.oid)=1
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a WHERE a.member=k.oid)
      AND NOT pg_catalog.pg_has_role(m.oid,r.oid,'MEMBER') AND NOT pg_catalog.pg_has_role(m.oid,j.oid,'MEMBER')
      AND pg_catalog.has_schema_privilege(m.oid,'public','USAGE') AND NOT pg_catalog.has_schema_privilege(m.oid,'public','CREATE')
      AND NOT pg_catalog.has_database_privilege(m.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS (SELECT 1 FROM all_downtown_relations d WHERE CASE WHEN d.relkind='S'
        THEN pg_catalog.has_sequence_privilege(m.oid,d.oid,'USAGE,SELECT,UPDATE')
        ELSE pg_catalog.has_table_privilege(m.oid,d.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END)
      AND NOT EXISTS (SELECT 1 FROM all_downtown_relations d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE d.relkind<>'S' AND pg_catalog.has_column_privilege(m.oid,d.oid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))
      AND NOT EXISTS (SELECT 1 FROM all_downtown_functions f WHERE pg_catalog.has_function_privilege(m.oid,f.oid,'EXECUTE') <>
        (f.oid=ANY(ARRAY[pg_catalog.to_regprocedure('public.downtown_u_kitchen_claim(integer)')::oid,
          pg_catalog.to_regprocedure('public.downtown_u_kitchen_finalize(uuid,text,text,bigint)')::oid,
          pg_catalog.to_regprocedure('public.downtown_u_kitchen_fail(uuid,text,boolean,integer,text,bigint)')::oid])))
      FROM me m CROSS JOIN kitchen_role k CROSS JOIN runtime_role r CROSS JOIN job_role j),false) safe,
      rd.relation_hash,fd.function_hash,hd.host_trigger_hash,ed.environment_hash
    FROM relation_descriptor rd CROSS JOIN function_descriptor fd CROSS JOIN host_trigger_descriptor hd CROSS JOIN environment_descriptor ed
  `);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.safe !== true || row.relation_hash !== RELATION_HASH || row.function_hash !== FUNCTION_HASH || row.host_trigger_hash !== HOST_TRIGGER_HASH || row.environment_hash !== ENVIRONMENT_HASH) {
    throw new Error("Unsafe Downtown U kitchen job database identity");
  }
}

function data(row: Record<string, unknown>, key: string, type: "string" | "object"): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor || !("value" in descriptor) || (type === "string" ? typeof descriptor.value !== "string" : typeof descriptor.value !== "object")) throw new Error("invalid kitchen capability result");
  return descriptor.value;
}

export class PostgresKitchenJobStore {
  constructor(private readonly pool: Pool, private readonly preflight = assertDowntownUKitchenJobIdentity) {}
  claim(limit: number): Promise<KitchenClaim[]> {
    return withPostgresTransaction(this.pool, async client => {
      await this.preflight(client);
      const result = await client.query("SELECT * FROM public.downtown_u_kitchen_claim($1::integer)", [limit]);
      return result.rows.map((raw: Record<string, unknown>) => {
        const action = data(raw, "action", "string");
        if (action !== "create" && action !== "cancel") throw new Error("invalid kitchen capability result");
        const version = raw.square_order_version === null ? null : Number(raw.square_order_version);
        if (version !== null && (!Number.isSafeInteger(version) || version < 0)) throw new Error("invalid kitchen capability result");
        if (!Array.isArray(raw.modifiers)) throw new Error("invalid kitchen capability result");
        return {
          leaseToken: data(raw, "lease_token", "string") as string, action, redemptionId: data(raw, "redemption_id", "string") as string,
          locationId: data(raw, "location_id", "string") as string, referenceId: data(raw, "reference_id", "string") as string,
          idempotencyKey: data(raw, "idempotency_key", "string") as string, mealName: data(raw, "meal_name", "string") as string,
          mealCatalogObjectId: data(raw, "meal_catalog_object_id", "string") as string, modifiers: raw.modifiers,
          squareOrderId: raw.square_order_id === null ? null : data(raw, "square_order_id", "string") as string, squareOrderVersion: version,
        };
      });
    });
  }
  finalize(claim: KitchenClaim, id: string, version: number): Promise<string> {
    return this.one("SELECT public.downtown_u_kitchen_finalize($1::uuid,$2::text,$3::text,$4::bigint) result", [claim.leaseToken, claim.action, id, version]);
  }
  fail(claim: KitchenClaim, code: string, permanent: boolean, delaySeconds: number, observed: KitchenObservedOrder | null = null): Promise<string> {
    return this.one("SELECT public.downtown_u_kitchen_fail($1::uuid,$2::text,$3::boolean,$4::integer,$5::text,$6::bigint) result", [claim.leaseToken, code, permanent, delaySeconds, observed?.id ?? null, observed?.version ?? null]);
  }
  private one(sql: string, values: unknown[]): Promise<string> {
    return withPostgresTransaction(this.pool, async (client: PoolClient) => {
      await this.preflight(client);
      const result = await client.query(sql, values);
      if (result.rows.length !== 1 || typeof result.rows[0].result !== "string") throw new Error("invalid kitchen capability result");
      return result.rows[0].result;
    });
  }
}
