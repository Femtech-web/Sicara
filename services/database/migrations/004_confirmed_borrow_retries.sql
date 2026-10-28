-- A NEW attempt is permitted only after the old attempt is conclusively reverted.
-- Unknown/broadcast/successful intents cannot be replaced by this mechanism.
ALTER TABLE sicara.sepolia_transactions ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3);
ALTER TABLE sicara.sepolia_transactions DROP CONSTRAINT sepolia_transactions_pkey;
ALTER TABLE sicara.sepolia_transactions ADD PRIMARY KEY(loan_id,stage,attempt);
ALTER TABLE sicara.sepolia_transactions DROP CONSTRAINT sepolia_transactions_state_check;
ALTER TABLE sicara.sepolia_transactions ADD CHECK(state IN ('prepared','confirmed','review','failed'));
CREATE UNIQUE INDEX one_unresolved_sepolia_stage ON sicara.sepolia_transactions(loan_id,stage) WHERE state <> 'failed';
CREATE OR REPLACE FUNCTION sicara.guard_sepolia_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.loan_id,NEW.stage,NEW.attempt,NEW.tx_hash,NEW.raw_transaction)
    IS DISTINCT FROM ROW(OLD.loan_id,OLD.stage,OLD.attempt,OLD.tx_hash,OLD.raw_transaction)
    OR (OLD.state='failed' AND NEW.state<>'failed') THEN
    RAISE EXCEPTION 'Sepolia transaction intent is immutable';
  END IF;
  RETURN NEW;
END $$;
