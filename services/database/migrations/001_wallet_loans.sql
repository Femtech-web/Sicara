-- Apply with the private migration role. Never expose this schema via PostgREST.
CREATE SCHEMA sicara;
REVOKE ALL ON SCHEMA sicara FROM PUBLIC;

CREATE TABLE sicara.auth_challenges (
  id uuid PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  browser_hash text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX challenge_wallet_created ON sicara.auth_challenges (wallet, created_at);
CREATE TABLE sicara.sessions (
  token_hash text PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX session_expiry ON sicara.sessions (expires_at);

CREATE TABLE sicara.loans (
  id uuid PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  request_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'allocating' CHECK (state IN (
    'allocating', 'awaiting_deposit', 'confirming', 'collateral_verified',
    'reorg_review', 'refund_pending', 'refunded', 'released'
  )),
  return_address text NOT NULL,
  deposit_address text UNIQUE,
  required_zatoshis numeric(16,0) NOT NULL CHECK (required_zatoshis > 0 AND required_zatoshis <= 2100000000000000),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet, request_key)
);
-- Cancellation/expiry retains this slot until all funds are reconciled/refunded.
CREATE UNIQUE INDEX one_open_loan_per_wallet ON sicara.loans (wallet)
  WHERE state NOT IN ('refunded', 'released');
CREATE INDEX loan_owner_created ON sicara.loans (wallet, created_at DESC);
CREATE FUNCTION sicara.guard_loan_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.wallet, NEW.request_key, NEW.return_address, NEW.required_zatoshis)
    IS DISTINCT FROM ROW(OLD.id, OLD.wallet, OLD.request_key, OLD.return_address, OLD.required_zatoshis)
    OR (OLD.deposit_address IS NOT NULL AND NEW.deposit_address IS DISTINCT FROM OLD.deposit_address) THEN
    RAISE EXCEPTION 'Loan binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_loan_binding BEFORE UPDATE ON sicara.loans
  FOR EACH ROW EXECUTE FUNCTION sicara.guard_loan_binding();

CREATE TABLE sicara.deposit_observations (
  note_id text PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES sicara.loans (id),
  zatoshis numeric(16,0) NOT NULL CHECK (zatoshis > 0 AND zatoshis <= 2100000000000000),
  height bigint,
  scan_tip bigint NOT NULL,
  present boolean NOT NULL,
  UNIQUE (note_id, loan_id)
);
CREATE INDEX notes_loan ON sicara.deposit_observations (loan_id);
CREATE FUNCTION sicara.guard_note_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.note_id, NEW.loan_id, NEW.zatoshis) IS DISTINCT FROM ROW(OLD.note_id, OLD.loan_id, OLD.zatoshis) THEN
    RAISE EXCEPTION 'Deposit identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_note_identity BEFORE UPDATE ON sicara.deposit_observations
  FOR EACH ROW EXECUTE FUNCTION sicara.guard_note_identity();
CREATE TABLE sicara.collateral_reservations (
  note_id text PRIMARY KEY,
  loan_id uuid NOT NULL,
  FOREIGN KEY (note_id, loan_id) REFERENCES sicara.deposit_observations (note_id, loan_id)
);
CREATE INDEX reservations_loan ON sicara.collateral_reservations (loan_id);
CREATE TABLE sicara.refund_intents (
  loan_id uuid PRIMARY KEY REFERENCES sicara.loans (id),
  destination text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('cancelled', 'expired', 'overpayment')),
  state text NOT NULL DEFAULT 'reconciliation_required' CHECK (state IN ('reconciliation_required', 'broadcast', 'confirmed')),
  txid text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- No browser/anon/authenticated role gets access, including if exposed accidentally.
-- The private backend role needs explicit privileges; it must never be shipped to clients.
ALTER TABLE sicara.auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.deposit_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.collateral_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sicara.refund_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sicara FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sicara FROM PUBLIC;

-- The runtime drops to this role for each transaction. Keep schema ownership/DDL
-- with the migration account. No password or browser JWT is created here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sicara_backend') THEN
    CREATE ROLE sicara_backend NOLOGIN;
  END IF;
END $$;
GRANT sicara_backend TO CURRENT_USER;
GRANT USAGE ON SCHEMA sicara TO sicara_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON sicara.auth_challenges, sicara.sessions TO sicara_backend;
GRANT SELECT, INSERT, UPDATE ON sicara.loans, sicara.deposit_observations,
  sicara.collateral_reservations, sicara.refund_intents TO sicara_backend;
CREATE POLICY backend_only ON sicara.auth_challenges TO sicara_backend USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON sicara.sessions TO sicara_backend USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON sicara.loans TO sicara_backend USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON sicara.deposit_observations TO sicara_backend USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON sicara.collateral_reservations TO sicara_backend USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON sicara.refund_intents TO sicara_backend USING (true) WITH CHECK (true);
