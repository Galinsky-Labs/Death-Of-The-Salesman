DROP TABLE app.ledger_fact_postings;
-- Destructive migration-owner rollback: retain financial evidence before production use.
DROP TABLE app.ledger_invoices;
DROP TABLE app.ledger_reservations;
DROP TABLE app.ledger_postings;
DROP TABLE app.ledger_journals;
DROP TABLE app.budget_accounts;
DROP TABLE app.ledger_currency_rules;
DROP FUNCTION app.ledger_require_open_journal();
DROP FUNCTION app.ledger_check_balance();
DROP FUNCTION app.ledger_deny_rewrite();


DROP FUNCTION app.ledger_check_fact();
DROP FUNCTION app.ledger_require_open_fact();
