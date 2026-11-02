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


-- Financial facts must cite exact, non-reusable supporting postings. These are
-- accounting provenance, not provider receipts or authorization to spend.
ALTER TABLE app.ledger_invoices ADD COLUMN created_in_xid bigint NOT NULL DEFAULT txid_current(),
  ADD CONSTRAINT invoice_tenant_id UNIQUE(organization_id,id);
ALTER TABLE app.ledger_reservations ADD COLUMN created_in_xid bigint NOT NULL DEFAULT txid_current(),
  ADD CONSTRAINT reservation_tenant_id UNIQUE(organization_id,id);
CREATE TABLE app.ledger_fact_postings (
  organization_id app.entity_id NOT NULL,
  invoice_id app.entity_id,
  reservation_id app.entity_id,
  phase text NOT NULL CHECK(phase IN ('allocated','incurred','paid','reserved')),
  journal_id app.entity_id NOT NULL,
  account_id app.entity_id NOT NULL,
  CHECK ((invoice_id IS NOT NULL AND reservation_id IS NULL AND phase<>'reserved') OR
         (invoice_id IS NULL AND reservation_id IS NOT NULL AND phase='reserved')),
  PRIMARY KEY(organization_id,journal_id,account_id),
  UNIQUE(organization_id,invoice_id,phase),
  UNIQUE(organization_id,reservation_id,phase),
  FOREIGN KEY(organization_id,invoice_id) REFERENCES app.ledger_invoices(organization_id,id),
  FOREIGN KEY(organization_id,reservation_id) REFERENCES app.ledger_reservations(organization_id,id),
  FOREIGN KEY(organization_id,journal_id,account_id) REFERENCES app.ledger_postings(organization_id,journal_id,account_id)
);
ALTER TABLE app.ledger_fact_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger_fact_postings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ledger_fact_postings
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE FUNCTION app.ledger_check_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant app.entity_id; invoice app.entity_id; reservation app.entity_id;
  fact app.ledger_invoices; hold app.ledger_reservations; item record; expected bigint; count_links integer;
BEGIN
  tenant:=NEW.organization_id;
  IF TG_TABLE_NAME='ledger_invoices' THEN invoice:=NEW.id;
  ELSIF TG_TABLE_NAME='ledger_reservations' THEN reservation:=NEW.id;
  ELSE invoice:=NEW.invoice_id; reservation:=NEW.reservation_id;
  END IF;
  IF invoice IS NOT NULL THEN
    SELECT * INTO STRICT fact FROM app.ledger_invoices WHERE organization_id=tenant AND id=invoice;
    SELECT count(*) INTO count_links FROM app.ledger_fact_postings WHERE organization_id=tenant AND invoice_id=invoice;
    IF count_links<>((fact.allocated_minor>0)::integer+(fact.incurred_minor>0)::integer+(fact.paid_minor>0)::integer) THEN
      RAISE EXCEPTION 'invoice evidence does not reconcile' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO STRICT hold FROM app.ledger_reservations WHERE organization_id=tenant AND id=reservation;
    SELECT count(*) INTO count_links FROM app.ledger_fact_postings WHERE organization_id=tenant AND reservation_id=reservation;
    IF count_links<>1 THEN RAISE EXCEPTION 'reservation evidence does not reconcile' USING ERRCODE='23514'; END IF;
  END IF;
  FOR item IN SELECT l.phase,p.amount_minor,p.currency,a.kind,p.account_id
    FROM app.ledger_fact_postings l JOIN app.ledger_postings p
      ON p.organization_id=l.organization_id AND p.journal_id=l.journal_id AND p.account_id=l.account_id
    JOIN app.budget_accounts a ON a.organization_id=p.organization_id AND a.id=p.account_id
    WHERE l.organization_id=tenant AND
      ((invoice IS NOT NULL AND l.invoice_id=invoice) OR (reservation IS NOT NULL AND l.reservation_id=reservation))
  LOOP
    IF invoice IS NOT NULL THEN
      expected:=CASE item.phase WHEN 'allocated' THEN fact.allocated_minor WHEN 'incurred' THEN fact.incurred_minor WHEN 'paid' THEN fact.paid_minor ELSE NULL END;
      IF item.currency<>fact.currency THEN RAISE EXCEPTION 'invoice evidence currency mismatch' USING ERRCODE='23514'; END IF;
    ELSE
      expected:=hold.amount_minor;
      IF item.currency<>hold.currency OR item.account_id<>hold.account_id THEN
        RAISE EXCEPTION 'reservation evidence account mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
    IF expected IS NULL OR expected<=0 OR item.amount_minor<>expected OR item.kind<>item.phase THEN
      RAISE EXCEPTION 'fact evidence amount or account kind mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_evidence AFTER INSERT ON app.ledger_invoices
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ledger_check_fact();
CREATE CONSTRAINT TRIGGER reservation_evidence AFTER INSERT ON app.ledger_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ledger_check_fact();
CREATE CONSTRAINT TRIGGER fact_evidence AFTER INSERT ON app.ledger_fact_postings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ledger_check_fact();
CREATE FUNCTION app.ledger_require_open_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.ledger_invoices WHERE organization_id=NEW.organization_id AND id=NEW.invoice_id AND created_in_xid=txid_current()) AND
     NOT EXISTS(SELECT 1 FROM app.ledger_reservations WHERE organization_id=NEW.organization_id AND id=NEW.reservation_id AND created_in_xid=txid_current()) THEN
    RAISE EXCEPTION 'financial fact is already recorded or unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER open_fact BEFORE INSERT ON app.ledger_fact_postings FOR EACH ROW EXECUTE FUNCTION app.ledger_require_open_fact();
CREATE TRIGGER immutable_fact_posting BEFORE UPDATE OR DELETE ON app.ledger_fact_postings FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_fact_posting_truncate BEFORE TRUNCATE ON app.ledger_fact_postings FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_invoice BEFORE UPDATE OR DELETE ON app.ledger_invoices FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_invoice_truncate BEFORE TRUNCATE ON app.ledger_invoices FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_reservation BEFORE UPDATE OR DELETE ON app.ledger_reservations FOR EACH ROW EXECUTE FUNCTION app.ledger_deny_rewrite();
CREATE TRIGGER immutable_reservation_truncate BEFORE TRUNCATE ON app.ledger_reservations FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_deny_rewrite();
