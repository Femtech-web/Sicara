ALTER TABLE sicara.loans DROP CONSTRAINT loans_state_check;
ALTER TABLE sicara.loans ADD CHECK(state IN (
 'allocating','awaiting_deposit','confirming','collateral_verified','reorg_review',
 'refund_pending','late_refund_pending','refunded','released',
 'issuance_pending','issuance_registered','issuance_review','release_pending','release_review'
));
ALTER TABLE sicara.sepolia_transactions DROP CONSTRAINT sepolia_transactions_stage_check;
ALTER TABLE sicara.sepolia_transactions ADD CHECK(stage IN ('register','borrow','approve','repay','request_settlement','settle','revoke'));

CREATE TABLE sicara.release_intents (
 loan_id uuid PRIMARY KEY REFERENCES sicara.collateral_authorizations(loan_id),
 destination text NOT NULL,
 zatoshis numeric(16,0) NOT NULL CHECK(zatoshis>0),
 settlement_tx text NOT NULL UNIQUE CHECK(settlement_tx ~ '^0x[0-9a-f]{64}$'),
 settlement_block bigint,
 settlement_block_hash text,
 state text NOT NULL DEFAULT 'awaiting_finality' CHECK(state IN ('awaiting_finality','authorized','confirmed','review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sicara.release_payments (
 id uuid PRIMARY KEY,
 loan_id uuid NOT NULL REFERENCES sicara.release_intents(loan_id),
 sequence integer NOT NULL CHECK(sequence>0),
 destination text NOT NULL,
 zatoshis numeric(16,0) NOT NULL CHECK(zatoshis>0 AND zatoshis<=1000000),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitting','broadcast','confirmed','review')),
 txid text UNIQUE,confirmed_height bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(loan_id,sequence),
 CHECK(state NOT IN ('broadcast','confirmed') OR txid IS NOT NULL)
);
CREATE UNIQUE INDEX one_pending_release_payment ON sicara.release_payments(loan_id) WHERE state IN ('prepared','submitting','broadcast');
CREATE TRIGGER immutable_release_payment BEFORE UPDATE ON sicara.release_payments
 FOR EACH ROW EXECUTE FUNCTION sicara.guard_refund_payment();
CREATE FUNCTION sicara.guard_release_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.loan_id,NEW.destination,NEW.zatoshis,NEW.settlement_tx) IS DISTINCT FROM ROW(OLD.loan_id,OLD.destination,OLD.zatoshis,OLD.settlement_tx)
 OR (OLD.settlement_block_hash IS NOT NULL AND ROW(NEW.settlement_block,NEW.settlement_block_hash) IS DISTINCT FROM ROW(OLD.settlement_block,OLD.settlement_block_hash)) THEN
  RAISE EXCEPTION 'Settlement/release binding is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_release_intent BEFORE UPDATE ON sicara.release_intents
 FOR EACH ROW EXECUTE FUNCTION sicara.guard_release_intent();
CREATE OR REPLACE FUNCTION sicara.prevent_issuance_downgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM sicara.collateral_authorizations WHERE loan_id=NEW.id)
 AND NEW.state NOT IN ('issuance_pending','issuance_registered','issuance_review') THEN
  IF NEW.state NOT IN ('release_pending','released','release_review') OR NOT EXISTS(
   SELECT 1 FROM sicara.release_intents WHERE loan_id=NEW.id AND
    (state IN ('authorized','confirmed') OR NEW.state='release_review')
  ) THEN RAISE EXCEPTION 'Authorized collateral remains frozen until verified settlement'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE sicara.release_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.release_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sicara.release_intents,sicara.release_payments FROM PUBLIC;
GRANT SELECT ON sicara.release_intents TO sicara_backend;
CREATE POLICY backend_read ON sicara.release_intents FOR SELECT TO sicara_backend USING(true);
GRANT SELECT,INSERT,UPDATE ON sicara.release_intents,sicara.release_payments TO sicara_worker;
CREATE POLICY worker_only ON sicara.release_intents TO sicara_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_only ON sicara.release_payments TO sicara_worker USING(true) WITH CHECK(true);
REVOKE ALL ON FUNCTION sicara.guard_release_intent() FROM PUBLIC;
