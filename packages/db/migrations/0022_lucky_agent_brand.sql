-- The column said "the proxy this agent reports through" and the schema said the
-- link was `set null` on delete, but no constraint ever existed: `parent_agent_id`
-- was a bare uuid. Deleting a relay therefore left every agent behind it pointing
-- at a row that was gone.
--
-- So the rows have to be made honest before the constraint can hold them. Any
-- instance where a relay has already been deleted is carrying those dangling
-- pointers right now, and `ADD CONSTRAINT` would refuse outright on that data.
-- Nulling them is the same thing the constraint would have done at the time.
UPDATE "agents" SET "parent_agent_id" = NULL
WHERE "parent_agent_id" IS NOT NULL
  AND "parent_agent_id" NOT IN (SELECT "id" FROM "agents");
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
