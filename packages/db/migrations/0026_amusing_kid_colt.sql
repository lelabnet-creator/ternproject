-- `IF NOT EXISTS`, et ce n'est pas de la prudence gratuite.
--
-- La migration 0025 a été publiée avec ces deux valeurs déjà dans son
-- `CREATE TYPE` — le SQL avait été corrigé à la main, l'instantané de drizzle
-- non, d'où cette migration-ci. Une base créée depuis 0025 les a donc déjà, et
-- un `ADD VALUE` sec y échouerait ; une base plus ancienne, elle, en a besoin.
-- Les deux existent en ce moment même, et une seule instruction doit convenir
-- aux deux.
ALTER TYPE "public"."agent_command_kind" ADD VALUE IF NOT EXISTS 'ui-on';--> statement-breakpoint
ALTER TYPE "public"."agent_command_kind" ADD VALUE IF NOT EXISTS 'ui-off';
