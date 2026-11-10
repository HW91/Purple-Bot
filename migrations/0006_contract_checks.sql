-- The bot's latest requirement-by-requirement check for a contract (JSON array), frozen when the bot enters.
ALTER TABLE contract_notes ADD COLUMN checks TEXT;
