-- 0010 is reserved by the independently developed audit unit; gaps are supported by the migration runner.
CREATE TABLE app.ledger_currency_rules (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_digits smallint NOT NULL CHECK (minor_digits BETWEEN 0 AND 3)
);
INSERT INTO app.ledger_currency_rules VALUES ('USD',2),('EUR',2),('GBP',2),('JPY',0),('KWD',3);
CREATE TABLE app.budget_accounts (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  currency text NOT NULL REFERENCES app.ledger_currency_rules(code),
  kind text NOT NULL CHECK (kind IN ('cash','allocated','reserved','incurred','paid','offset')),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE(organization_id,id,currency)
);
CREATE TABLE app.ledger_journals (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  currency text NOT NULL REFERENCES app.ledger_currency_rules(code),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120 AND idempotency_key=btrim(idempotency_key)),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT app.utc_now(),
  created_in_xid bigint NOT NULL DEFAULT txid_current(),
  UNIQUE(organization_id,id,currency), UNIQUE(organization_id,idempotency_key)
);
CREATE TABLE app.ledger_postings (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  journal_id app.entity_id NOT NULL,
  account_id app.entity_id NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor<>0),
  UNIQUE(organization_id,journal_id,account_id),
  FOREIGN KEY(organization_id,journal_id,currency) REFERENCES app.ledger_journals(organization_id,id,currency),
  FOREIGN KEY(organization_id,account_id,currency) REFERENCES app.budget_accounts(organization_id,id,currency)
);
CREATE TABLE app.ledger_reservations (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  account_id app.entity_id NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  state text NOT NULL CHECK(state IN ('open','settled','released')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(organization_id,account_id,currency) REFERENCES app.budget_accounts(organization_id,id,currency)
);
CREATE TABLE app.ledger_invoices (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  currency text NOT NULL REFERENCES app.ledger_currency_rules(code),
  allocated_minor bigint NOT NULL CHECK(allocated_minor>=0),
  incurred_minor bigint NOT NULL CHECK(incurred_minor>=0),
  paid_minor bigint NOT NULL CHECK(paid_minor>=0 AND paid_minor<=incurred_minor),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['budget_accounts','ledger_journals','ledger_postings','ledger_reservations','ledger_invoices'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name);
  END LOOP;
END $$;
CREATE FUNCTION app.ledger_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal app.entity_id; tenant app.entity_id; n bigint; total numeric;
BEGIN
  IF TG_TABLE_NAME='ledger_journals' THEN journal:=NEW.id; ELSE journal:=NEW.journal_id; END IF;
  tenant:=NEW.organization_id;
  SELECT count(*),COALESCE(sum(amount_minor),0) INTO n,total FROM app.ledger_postings WHERE organization_id=tenant AND journal_id=journal;
  IF n<2 OR n>200 OR total<>0 THEN RAISE EXCEPTION 'journal is not balanced' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_header_balance AFTER INSERT ON app.ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ledger_check_balance();
CREATE CONSTRAINT TRIGGER ledger_posting_balance AFTER INSERT ON app.ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ledger_check_balance();
CREATE FUNCTION app.ledger_deny_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'posted ledger is immutable; post a reversing journal' USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON app.ledger_journals FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_posting BEFORE UPDATE OR DELETE ON app.ledger_postings FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_journal_truncate BEFORE TRUNCATE ON app.ledger_journals FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_posting_truncate BEFORE TRUNCATE ON app.ledger_postings FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE FUNCTION app.ledger_require_open_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.ledger_journals WHERE organization_id=NEW.organization_id AND id=NEW.journal_id AND created_in_xid=txid_current()) THEN
    RAISE EXCEPTION 'journal is already posted or unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_open_journal BEFORE INSERT ON app.ledger_postings FOR EACH ROW EXECUTE FUNCTION app.ledger_require_open_journal();
ALTER TABLE app.ledger_currency_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger_currency_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY currency_rules_read ON app.ledger_currency_rules FOR SELECT USING(true);
CREATE TRIGGER immutable_currency BEFORE UPDATE OR DELETE ON app.ledger_currency_rules FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_currency_truncate BEFORE TRUNCATE ON app.ledger_currency_rules FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_account BEFORE UPDATE OR DELETE ON app.budget_accounts FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_account_truncate BEFORE TRUNCATE ON app.budget_accounts FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
