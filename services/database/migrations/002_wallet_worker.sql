ALTER TABLE sicara.loans DROP CONSTRAINT loans_state_check;
ALTER TABLE sicara.loans ADD CONSTRAINT loans_state_check CHECK (state IN (
  'allocating', 'awaiting_deposit', 'confirming', 'collateral_verified',
  'reorg_review', 'refund_pending', 'late_refund_pending', 'refunded', 'released'
));
DROP INDEX sicara.one_open_loan_per_wallet;
CREATE UNIQUE INDEX one_open_loan_per_wallet ON sicara.loans(wallet)
  WHERE state NOT IN ('refunded', 'released', 'late_refund_pending');

CREATE TABLE sicara.wallet_worker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL,
  wallet_fingerprint text NOT NULL,
  last_tip bigint,
  scanned_at timestamptz
);
CREATE TABLE sicara.address_allocations (
  loan_id uuid PRIMARY KEY REFERENCES sicara.loans(id),
  state text NOT NULL CHECK (state IN ('pending', 'allocated', 'review')),
  return_receiver text NOT NULL,
  deposit_address text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='allocated') = (deposit_address IS NOT NULL))
);
CREATE TABLE sicara.refund_payments (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES sicara.refund_intents(loan_id),
  sequence integer NOT NULL CHECK (sequence > 0),
  destination text NOT NULL,
  zatoshis numeric(16,0) NOT NULL CHECK (zatoshis > 0 AND zatoshis <= 1000000),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','submitting','broadcast','confirmed','review')),
  txid text UNIQUE,
  confirmed_height bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(loan_id, sequence),
  CHECK (state NOT IN ('broadcast','confirmed') OR txid IS NOT NULL)
);
CREATE UNIQUE INDEX one_pending_refund_payment ON sicara.refund_payments(loan_id)
  WHERE state IN ('prepared','submitting','broadcast');
CREATE INDEX refund_payment_loan ON sicara.refund_payments(loan_id);

CREATE FUNCTION sicara.guard_refund_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.loan_id,NEW.sequence,NEW.destination,NEW.zatoshis)
    IS DISTINCT FROM ROW(OLD.id,OLD.loan_id,OLD.sequence,OLD.destination,OLD.zatoshis)
    OR (OLD.txid IS NOT NULL AND NEW.txid IS DISTINCT FROM OLD.txid) THEN
    RAISE EXCEPTION 'Refund payment binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_refund_payment BEFORE UPDATE ON sicara.refund_payments
  FOR EACH ROW EXECUTE FUNCTION sicara.guard_refund_payment();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sicara_worker') THEN
    CREATE ROLE sicara_worker NOLOGIN;
  END IF;
END $$;
GRANT sicara_backend TO sicara_worker;
GRANT sicara_worker TO CURRENT_USER;
ALTER TABLE sicara.wallet_worker ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.address_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.refund_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sicara.wallet_worker, sicara.address_allocations, sicara.refund_payments FROM PUBLIC;
REVOKE ALL ON FUNCTION sicara.guard_refund_payment() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON sicara.wallet_worker, sicara.address_allocations,
  sicara.refund_payments TO sicara_worker;
CREATE POLICY worker_only ON sicara.wallet_worker TO sicara_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_only ON sicara.address_allocations TO sicara_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_only ON sicara.refund_payments TO sicara_worker USING(true) WITH CHECK(true);
