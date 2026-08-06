ALTER TABLE "ip_allowlist" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ip_allowlist" CASCADE;--> statement-breakpoint
DROP INDEX "tenants_visibility_idx";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "visibility";--> statement-breakpoint
DROP TYPE "public"."tenant_visibility";