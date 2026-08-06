CREATE TYPE "public"."page_layout" AS ENUM('list', 'grid', 'compact');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "layout" "page_layout" DEFAULT 'list' NOT NULL;--> statement-breakpoint
ALTER TABLE "controls" ADD COLUMN "widget" text DEFAULT 'uptime-ribbon' NOT NULL;--> statement-breakpoint
ALTER TABLE "controls" ADD COLUMN "widget_options" jsonb DEFAULT '{}'::jsonb NOT NULL;