# Repository Audit and Multi-Business Rollout

## Findings addressed in this change

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | A tenant ID was interpolated into a filesystem path without validation, permitting path traversal through firm endpoints. | Tenant IDs now use a strict allowlist pattern before any config read/write. |
| High | Onboarding displayed industries but never persisted the selected industry, so every new customer inherited Redwood's personal-injury behavior. | Onboarding now sends stable backend industry keys, industry-specific intake rules, and question wording. |
| High | UI tone values (`warm-professional`, `formal`, capitalized settings values) did not match backend-supported values and silently fell back. | Both onboarding and settings now use the canonical `warm`, `professional`, and `friendly` values. |
| High | Unknown/missing industry behavior defaulted to personal-injury law. | Runtime fallback is now the general small-business module. |
| Medium | Core prompts and deterministic questions said “attorney,” “firm,” and “legal matter” for every business. | Runtime wording is business-neutral and becomes legal-specific only for legal industry keys. |
| Medium | Configuration writes accepted arbitrary keys, invalid email/URL values, unlimited strings, and invalid numeric bounds. | A reusable normalization boundary now rejects malformed and unsupported configuration. |
| Medium | Financial was offered in onboarding but had no runtime industry module. | Added a financial-services module with explicit sensitive-data and advice guardrails. |
| Medium | Contact fields collected during onboarding were discarded. | Contact name/email now persist in the tenant configuration. |
| Process | There was no product doctrine or tenant launch definition. | Added the doctrine and readiness checklist in `PRODUCT_DOCTRINE.md`. |

## Known follow-up risks

1. **Authentication/authorization:** firm administration endpoints rely on deployment-level protection; add session-based role and tenant authorization before broad self-service exposure.
2. **File-backed configuration:** atomic JSON is adequate for the current single-instance service, but multi-region/multi-instance deployment needs a transactional configuration database with revisions.
3. **Tenant selection in the web app:** several pages default to `firm_default`; replace query-string/default selection with the authenticated user's tenant membership.
4. **PII lifecycle:** document retention, deletion, export, encryption, access logging, and consent requirements per industry and jurisdiction.
5. **Webhook security:** add per-tenant signing secrets, timestamped signatures, replay protection, and an operator retry UI.
6. **Industry breadth:** medical and financial usage needs counsel/compliance review and dedicated simulations before production claims.
7. **Provisioning:** automate Twilio number assignment and webhook verification so copying a URL is not a hidden manual failure point.

## Recommended rollout

1. Pilot one home-services tenant using a separate Twilio number and notification inbox.
2. Run scripted calls for happy path, wrong service, silence, correction, emergency, and sensitive-data attempts.
3. Confirm tenant-scoped dashboard records and outbound delivery, then obtain customer script approval.
4. Run for one week with daily transcript review and no automated consequential actions.
5. Add authenticated tenant ownership and a database-backed configuration revision log before opening self-service signup.

