-- What install a row is, as the agent itself decides. Null for everything that
-- exists today: those were paired before agents carried an identifier, and they
-- keep the behaviour they had — pairing again gives them a new row. They stop
-- doing that once their agent is new enough to send one.
--
-- Deliberately not unique. Several nulls are the normal state here, and a
-- unique index would be a constraint on history rather than on what the column
-- means.
ALTER TABLE "agents" ADD COLUMN "install_id" text;