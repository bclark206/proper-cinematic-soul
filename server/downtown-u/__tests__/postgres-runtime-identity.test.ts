import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertDowntownURuntimeIdentity } from "../postgres-runtime-identity";
import { PostgresWebhookEventStore } from "../postgres-webhook-event-store";

describe("Downtown U runtime database identity preflight", () => {
  it("uses explicit effective object, column, function, and assumable-owner allowlists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe_runtime_identity: true }] });
    const pool = { query } as unknown as Pool;
    await assertDowntownURuntimeIdentity(pool);
    const sql = String(query.mock.calls[0][0]);

    expect(sql).toContain("expected_relations");
    expect(sql).toContain("expected_columns");
    expect(sql).toContain("has_table_privilege(CURRENT_USER");
    expect(sql).toContain("has_column_privilege(CURRENT_USER");
    expect(sql).toContain("expected_functions");
    expect(sql).toContain("to_regprocedure");
    expect(sql).toContain("has_function_privilege(CURRENT_USER");
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain("pg_catalog.acldefault('f', d.proowner)");
    expect(sql).toContain("CASE WHEN e.proname='downtown_u_reverse_expired_reservations' THEN 1 WHEN e.allow_execute THEN 1 ELSE 0 END");
    expect(sql).toContain("a.grantee<>CASE WHEN e.proname='downtown_u_reverse_expired_reservations' THEN jr.oid ELSE rr.oid END");
    expect(sql).toContain("a.is_grantable");
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("l.lanname");
    expect(sql).toContain("p.proconfig");
    expect(sql).toContain("d.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]");
    expect(sql).toContain("expected_auth_function_fingerprints");
    expect(sql).toContain("auth_function_fingerprints");
    expect(sql).toContain("pg_catalog.sha256");
    expect(sql).toContain("pg_catalog.convert_to");
    expect(sql).toContain("pg_catalog.jsonb_build_object");
    expect(sql).toContain("p.prosrc");
    expect(sql).toContain("p.proallargtypes");
    expect(sql).toContain("p.proargmodes");
    expect(sql).toContain("p.provolatile");
    expect(sql).toContain("p.proisstrict");
    expect(sql).toContain("p.proparallel");
    expect(sql).not.toMatch(/\bmd5\s*\(/i);
    expect(sql).toContain("d.proowner <> o.oid");
    expect(sql).toContain("pg_catalog.pg_get_expr(t.tgqual, t.tgrelid, true)");
    expect(sql).toContain("t.tgnargs AS argument_count");
    expect(sql).toContain("pg_catalog.encode(t.tgargs, 'hex')");
    expect(sql).toContain("d.when_expression IS DISTINCT FROM e.when_expression");
    expect(sql).toContain("d.argument_count <> e.argument_count");
    expect(sql).toContain("d.arguments_hex <> e.arguments_hex");
    expect(sql).toContain("pg_has_role(CURRENT_USER, d.relowner, 'MEMBER')");
    expect(sql).toContain("pg_has_role(CURRENT_USER, d.proowner, 'MEMBER')");
    expect(sql).toMatch(/NOT rr\.rolcanlogin/i);
    expect(sql).toMatch(/NOT rr\.rolreplication/i);
    expect(sql).toMatch(/NOT rr\.rolbypassrls/i);
    expect(sql).toMatch(/relkind\s*=\s*'S'/i);
    expect(sql).toContain("auth_relation_catalog");
    expect(sql).toContain("c.relhasrules");
    expect(sql).toContain("c.relam");
    expect(sql).toContain("am.amname AS access_method");
    expect(sql).toContain("auth_rewrite_rules");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM auth_rewrite_rules)");
    expect(sql).toContain("downtown_u_create_auth_challenge(text,text,text,text,smallint,bytea)");
    expect(sql).toContain("downtown_u_consume_auth_challenge(text,smallint,bytea,text,smallint,bytea)");
    expect(sql).not.toContain("downtown_u_create_auth_challenge(text,text,text,text,smallint,bytea,integer");
    expect(sql).not.toContain("downtown_u_consume_auth_challenge(text,smallint,bytea,text,smallint,bytea,integer");
    expect(sql).not.toContain("has_table_privilege('downtown_u_runtime'");
    expect(sql).not.toContain("has_function_privilege('downtown_u_runtime'");
  });

  it("revalidates a safe identity on every call, including concurrent calls", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe_runtime_identity: true }] });
    const pool = { query } as unknown as Pool;
    await Promise.all([assertDowntownURuntimeIdentity(pool), assertDowntownURuntimeIdentity(pool)]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("revalidates rejection and prevents capability queries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe_runtime_identity: false }] });
    const connect = vi.fn();
    const pool = { query, connect } as unknown as Pool;
    const store = new PostgresWebhookEventStore(pool);
    await expect(store.claim("evt_1", "payment.updated", "a".repeat(64))).rejects.toThrow(/unsafe/i);
    await expect(store.claim("evt_2", "payment.updated", "b".repeat(64))).rejects.toThrow(/unsafe/i);
    expect(query).toHaveBeenCalledTimes(2);
    expect(connect).not.toHaveBeenCalled();
  });
});