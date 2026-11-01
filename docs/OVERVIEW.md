# DOTS-028 — evidence-grounded owner overview

The main synthetic-preview page now includes eight labeled overview cards. The model
distinguishes **Synthetic** roster counts from **Verified** server observations,
**Configured** disabled-by-default controls, and **Not connected** outcomes.
Unknown sales, contacts, campaigns, revenue, and active workers display an em dash,
never a fake zero or an invented live count.

`deriveOverview` rejects any synthetic preview that supplies production numbers,
a positive paid spending cap, an enabled outbound gateway, or a purported live
observation timestamp. Real production adapters must fetch tenant-scoped,
server-authorized, durable data and provide a canonical UTC evidence timestamp.
A source string alone does not authenticate an observation or bypass tenancy.

This PR is a read-only UI/model milestone and does **not** implement live
telemetry, tenant API access, payment reconciliation, dispatch, or model inference.
There are no background polling loops, new credentials, migrations, provider
charges or production deployments. Source records remain controlled by their
respective later roadmap units. Do not interpret the zero-dollar cap as
confirmation of paid-provider expenditure.

Next work: DOTS-026 deployment assignments, DOTS-027 touch and keyboard
alternatives, DOTS-029 responsive screenshots, and later audited billing,
CRM, and production evidence adapters.
