CREATE TYPE "public"."probe_policy" AS ENUM('single', 'all');--> statement-breakpoint
CREATE TABLE "control_agents" (
	"control_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_agents_control_id_agent_id_pk" PRIMARY KEY("control_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "controls" ADD COLUMN "probe_policy" "probe_policy" DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "control_agents" ADD CONSTRAINT "control_agents_control_id_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."controls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_agents" ADD CONSTRAINT "control_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_agents_agent_idx" ON "control_agents" USING btree ("agent_id");