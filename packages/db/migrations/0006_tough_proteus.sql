ALTER TABLE "tenants" ADD COLUMN "smtp" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smtp_password_enc" text;