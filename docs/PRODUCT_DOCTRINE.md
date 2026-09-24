# Ava Multi-Business Product Doctrine

## Mission

Ava is a configurable phone-intake platform for service businesses. Redwood Legal is the reference tenant, not the product boundary. A new business must be able to launch without a code change, and one tenant's identity, data, instructions, or credentials must never affect another tenant.

## Non-negotiable principles

1. **Configuration, not forks.** Business identity, industry, services, scripts, questions, hours, notifications, and delivery integrations belong in a validated tenant configuration. Do not add customer-name conditionals to application code.
2. **Tenant isolation by construction.** Every call, lead, notification, webhook, and dashboard query is scoped by a validated tenant ID. Unknown tenants fail closed at administrative APIs. Never accept path separators or arbitrary filenames as IDs.
3. **Industry-aware, business-neutral language.** Internal legacy field names may remain for compatibility, but callers should hear “service,” “team,” or an industry-specific term—not “legal matter,” “firm,” or “attorney” unless the tenant is legal.
4. **Safe defaults are generic.** Missing industry behavior falls back to `general`, not to a legal specialty. Regulated verticals add safeguards; tenant instructions may supplement but never override global safety rules.
5. **Minimum necessary data.** Collect only what the business needs to return the inquiry. Never solicit passwords, payment-card data, Social Security numbers, bank-account numbers, or unnecessary health details.
6. **Humans own consequential decisions.** Ava records and routes inquiries. It does not diagnose, advise, guarantee eligibility, accept engagements, approve credit, bind prices, or promise outcomes.
7. **Observable delivery.** A completed intake is not useful until it is durably stored and its configured notifications/webhooks are attempted and auditable.
8. **Test the tenant boundary.** Each configuration or conversation change needs coverage for one legal and one non-legal tenant, invalid IDs, invalid configuration, and fallback behavior.

## Tenant configuration contract

Each tenant has one `streaming/data/firms/<firm_id>.json` document. IDs use `firm_` followed by lowercase letters, numbers, or underscores. Required launch data:

- business and assistant names;
- supported industry key and tone;
- at least one service/practice area;
- opening and closing scripts;
- required intake fields and question wording;
- office hours/time zone;
- safety disclaimer and intake rules;
- notification destination and/or delivery webhook;
- Twilio routing URL: `/twiml?firmId=<firm_id>`.

The API normalizes and validates configurations before atomic persistence. Secrets never belong in tenant JSON; they remain environment variables or a future encrypted secret store.

## Definition of ready

A tenant is ready for production only when:

- configuration validation passes;
- opening, each intake question, out-of-scope handling, closing, and emergency handling have been test-called;
- Twilio signature validation is enabled and the assigned number routes to the correct tenant ID;
- email/SMS/webhook delivery has been exercised;
- dashboard data shows only that tenant;
- the customer approves scripts, data collected, retention expectations, and escalation instructions;
- rollback ownership and an incident contact are recorded.

## Change doctrine

Prefer this order: update a tenant configuration; extend a reusable industry profile; extend the validated configuration contract; only then change the core conversation engine. Any new industry must define vocabulary, required information, prohibited behavior, urgency rules, and at least one regression scenario.

