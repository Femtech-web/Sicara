ALTER TABLE sicara.loans DROP CONSTRAINT loans_state_check;
ALTER TABLE sicara.loans ADD CONSTRAINT loans_state_check CHECK (state IN (
  'allocating','awaiting_deposit','confirming','collateral_verified','reorg_review',
  'refund_pending','late_refund_pending','refunded','released',
  'issuance_pending','issuance_registered','issuance_review'
));

CREATE TABLE sicara.collateral_authorizations (
  loan_id uuid PRIMARY KEY REFERENCES sicara.loans(id),
  chain_id bigint NOT NULL CHECK (chain_id=11155111),
  pool text NOT NULL CHECK (pool ~ '^0x[0-9a-f]{40}$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  chain_loan_id text NOT NULL UNIQUE CHECK (chain_loan_id ~ '^0x[0-9a-f]{64}$'),
  deposit_commitment text NOT NULL UNIQUE CHECK (deposit_commitment ~ '^0x[0-9a-f]{64}$'),
  valid_until bigint NOT NULL,
  capacity_units numeric(20,0) NOT NULL CHECK (capacity_units>0 AND capacity_units<=18446744073709551615),
  scan_tip bigint NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','prepared','signed','registered','review')),
  capacity_input text,
  input_proof text,
  signature text,
  registration_tx text UNIQUE,
  registration_block bigint,
  registration_block_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION sicara.guard_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.loan_id,NEW.chain_id,NEW.pool,NEW.policy_hash,NEW.chain_loan_id,NEW.deposit_commitment,NEW.valid_until,NEW.capacity_units,NEW.scan_tip)
    IS DISTINCT FROM ROW(OLD.loan_id,OLD.chain_id,OLD.pool,OLD.policy_hash,OLD.chain_loan_id,OLD.deposit_commitment,OLD.valid_until,OLD.capacity_units,OLD.scan_tip)
    OR (OLD.capacity_input IS NOT NULL AND ROW(NEW.capacity_input,NEW.input_proof) IS DISTINCT FROM ROW(OLD.capacity_input,OLD.input_proof))
    OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature)
    OR (OLD.registration_tx IS NOT NULL AND NEW.registration_tx IS DISTINCT FROM OLD.registration_tx) THEN
    RAISE EXCEPTION 'Collateral authorization binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_authorization BEFORE UPDATE ON sicara.collateral_authorizations
FOR EACH ROW EXECUTE FUNCTION sicara.guard_authorization();

-- Authorizations NEVER automatically expire into refunds. A registration could
-- have executed just before expiry. Chain reconciliation/manual recovery is required.
CREATE FUNCTION sicara.prevent_authorized_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sicara.collateral_authorizations WHERE loan_id=NEW.loan_id) THEN
    RAISE EXCEPTION 'Authorized collateral cannot enter pre-issuance refund';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER no_authorized_refund BEFORE INSERT OR UPDATE ON sicara.refund_intents
FOR EACH ROW EXECUTE FUNCTION sicara.prevent_authorized_refund();
CREATE FUNCTION sicara.prevent_issuance_downgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sicara.collateral_authorizations WHERE loan_id=NEW.id)
    AND NEW.state NOT IN ('issuance_pending','issuance_registered','issuance_review') THEN
    RAISE EXCEPTION 'Authorized collateral remains frozen until settlement integration';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER no_issuance_downgrade BEFORE UPDATE ON sicara.loans
FOR EACH ROW EXECUTE FUNCTION sicara.prevent_issuance_downgrade();

CREATE TABLE sicara.sepolia_transactions (
  loan_id uuid NOT NULL REFERENCES sicara.collateral_authorizations(loan_id),
  stage text NOT NULL CHECK(stage IN ('register','borrow')),
  tx_hash text NOT NULL UNIQUE CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
  raw_transaction text NOT NULL CHECK(raw_transaction ~ '^0x[0-9a-f]+$'),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','confirmed','review')),
  block_number bigint,
  block_hash text,
  PRIMARY KEY(loan_id,stage)
);
CREATE FUNCTION sicara.guard_sepolia_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.loan_id,NEW.stage,NEW.tx_hash,NEW.raw_transaction)
    IS DISTINCT FROM ROW(OLD.loan_id,OLD.stage,OLD.tx_hash,OLD.raw_transaction) THEN
    RAISE EXCEPTION 'Sepolia transaction intent is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_sepolia_transaction BEFORE UPDATE ON sicara.sepolia_transactions
FOR EACH ROW EXECUTE FUNCTION sicara.guard_sepolia_transaction();

ALTER TABLE sicara.collateral_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.sepolia_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sicara.collateral_authorizations,sicara.sepolia_transactions FROM PUBLIC;
GRANT SELECT ON sicara.collateral_authorizations TO sicara_backend;
CREATE POLICY backend_read ON sicara.collateral_authorizations FOR SELECT TO sicara_backend USING(true);
GRANT SELECT,INSERT,UPDATE ON sicara.collateral_authorizations,sicara.sepolia_transactions TO sicara_worker;
CREATE POLICY worker_only ON sicara.collateral_authorizations TO sicara_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_only ON sicara.sepolia_transactions TO sicara_worker USING(true) WITH CHECK(true);
REVOKE ALL ON FUNCTION sicara.guard_authorization(),sicara.prevent_authorized_refund(),
  sicara.prevent_issuance_downgrade(),sicara.guard_sepolia_transaction() FROM PUBLIC;
