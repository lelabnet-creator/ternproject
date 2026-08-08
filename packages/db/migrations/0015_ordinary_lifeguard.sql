ALTER TYPE "public"."page_layout" ADD VALUE 'custom';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_html" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_css" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_js" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;