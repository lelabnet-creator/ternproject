CREATE TYPE "public"."agent_role" AS ENUM('agent', 'proxy');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role" "agent_role" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "parent_agent_id" uuid;