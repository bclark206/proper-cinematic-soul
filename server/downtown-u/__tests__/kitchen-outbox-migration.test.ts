import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/202608040008_downtown_u_kitchen_outbox.sql"), "utf8");
const store = readFileSync(resolve(process.cwd(), "server/downtown-u/postgres-kitchen-job-store.ts"), "utf8");

describe("kitchen outbox migration contract", () => {
  it("atomically enqueues immutable trusted snapshots with stable keys", () => {
    expect(sql).toContain("AFTER INSERT ON public.downtown_u_reservation_snapshots");
    expect(sql).toContain("'du-create-'||NEW.redemption_id::text");
    expect(sql).toContain("NEW.meal_square_catalog_object_id");
    expect(sql).toContain("BEFORE TRUNCATE ON public.downtown_u_kitchen_order_outbox");
  });

  it("uses bounded SKIP LOCKED leases, fresh expiry checks, and an owner disabled gate", () => {
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("LIMIT requested_limit");
    expect(sql).toContain("attempt_count BETWEEN 0 AND 12");
    expect(sql).toContain("redemption.expires_at>now_at");
    expect(sql).toContain("c.enabled AND c.location_id='LPPWSSV03BHK8'");
  });

  it("grants only exact capabilities to a separate NOLOGIN role", () => {
    expect(sql).toContain("CREATE ROLE downtown_u_kitchen_jobs NOLOGIN");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.downtown_u_kitchen_claim(INTEGER),public.downtown_u_kitchen_finalize(UUID,TEXT,TEXT,BIGINT)");
    expect(sql).not.toMatch(/GRANT .*downtown_u_(student|checkout|reverse_expired).*kitchen_jobs/i);
  });

  it("normalizes ACL ordering semantically and owns both cross-table trigger descriptors", () => {
    expect(store).toContain("THEN 'OWNER'");
    expect(store).toContain("THEN 'PUBLIC'");
    expect(store).toContain("THEN 'KITCHEN'");
    expect(store).not.toMatch(/ORDER BY z\.grantee\b/);
    expect(store).toContain("(SELECT count(*) FROM kitchen_host_triggers)=2");
    expect(store).toContain("n.nspname AS host_schema");
    expect(store).toContain("'host_schema',t.host_schema,'host_relation',t.host_relation");
    expect(store).toContain("pg_catalog.pg_get_triggerdef(t.oid,true)");
    expect(store).toContain("function_oid_matches");
    expect(store).toContain("security_config");
  });
});
