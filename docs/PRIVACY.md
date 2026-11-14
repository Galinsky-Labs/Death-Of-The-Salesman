# Privacy, consent, correction and deletion (DOTS-146)

## Data inventory

| Data | Where | Purpose | Retention |
|---|---|---|---|
| Owner identity (email, auth session) | Neon Auth, `app.owner_users`, `app.memberships` | Owner sign-in and authorization | While the workspace exists |
| Contacts (name, email, role, source, consent evidence, jurisdiction) | `app.crm_contacts`, consent and suppression tables | Owner-reviewed relationship management | Until redacted or retention review; suppression hashes retained to honor opt-outs |
| Messages and conversations | `app.messages`, `app.conversations` | Owner-approved correspondence | Until redaction of the contact |
| Documents | `app.document_library` (AES-256-GCM) | Owner pitch/grant material | Until deleted by retention policy |
| Financial evidence | `app.money_entries`, `app.invoices`, receipts | Bookkeeping and reconciliation | Append-only; legal retention |
| Operational and audit events | `app.operation_events`, `app.audit_events`, incidents | Security and accountability | Append-only |

## Processors (sub-processors only when enabled by the owner)

| Processor | Data shared | Default |
|---|---|---|
| Render (hosting, Ohio) | All application traffic | Enabled |
| Neon (database and auth, AWS us-east-2) | All stored data, owner email | Enabled |
| OpenRouter → Google AI Studio (free Gemma) | Public, non-personal task briefs and approved facts only | Optional; may retain prompts |
| OpenAI / Anthropic / xAI | Task context permitted by privacy class | Disabled until owner key and funded cap |
| Resend | Recipient email, message content | Disabled until verified sender and policy |
| Stripe | Invoice amount, label, payment metadata | Disabled until merchant authorization |
| Grants.gov | Search keywords only | Public API |

## Data-subject rights

- **Access/export:** Contacts export (`/api/export?resource=contacts`) and full workspace export
  (`/api/export?resource=workspace`); per-contact timelines are visible in the CRM inspector.
- **Correction:** Contact details and consent evidence are editable; every change is versioned and audited.
- **Opt-out:** Signed one-click unsubscribe links and owner suppression apply across every campaign and agent.
  Suppression keeps only a SHA-256 hash of the email to prevent re-contact.
- **Erasure:** Redaction removes name, email, role, source evidence, notes and message bodies while retaining
  the suppression hash and financial evidence required by law.
- **Retention:** Retention annotations and deletion requests with evidence holds are managed in the Safety view.

## Jurisdictions

Outbound email is blocked unless the contact's reviewed jurisdiction is in `EMAIL_ALLOWED_JURISDICTIONS`.
GDPR (EU/UK) and CASL (Canada) outreach remain **disabled** until the owner records a reviewed lawful basis
and policy for those regions — blocked on external prerequisite (legal review). CAN-SPAM requirements
(accurate headers, postal address, working opt-out) are enforced before any send.
