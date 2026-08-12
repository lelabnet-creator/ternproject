-- `IF NOT EXISTS`, pour la même raison que 0026.
--
-- Une valeur d'énumération ne s'ajoute pas deux fois, et un `ADD VALUE` sec
-- échoue sur une base qui l'a déjà. Rien ici ne dépend de l'ordre des valeurs,
-- donc la forme idempotente convient à toutes les bases à la fois — celles qui
-- viennent de 0025 comme celles créées après.
ALTER TYPE "public"."agent_command_kind" ADD VALUE IF NOT EXISTS 'upgrade';
