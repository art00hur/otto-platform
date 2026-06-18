# Pipedrive API Documentation for Otto

This directory contains the complete Pipedrive API reference for building the Otto integration.

## Files

| File | Content |
|------|---------|
| `01-oauth.md` | OAuth 2.0 flow, token exchange, refresh, scopes, revocation |
| `02-deals.md` | Deals API (list, get, search, fields, pipelines, stages) |
| `03-persons-organizations.md` | Persons & Organizations API (list, get, search, fields, relations) |
| `04-activities-webhooks-ratelimits.md` | Activities API, Webhooks (v1/v2), Rate limiting |

## Otto Integration Rules

- **READ-ONLY**: Otto only uses `:read` scopes. No write operations.
- **Scopes requested**: `deals:read contacts:read activities:read leads:read`
- **Token storage**: AES-256-GCM encrypted in `integrations` table
- **Token refresh**: Automatic, 5min before expiry
- **Proxy**: All Pipedrive API calls go through `/api/integrations/pipedrive/proxy/*` (GET only)
- **Per-client**: Each client has their own OAuth tokens via `api_domain` from token response

## Key Endpoints Used by Otto Agents

```
GET /v2/deals                    — Pipeline overview
GET /v2/deals?person_id=X       — Deals for a contact
GET /v1/deals/search?term=X     — Search deals
GET /v1/persons                  — List contacts
GET /v1/persons/search?term=X   — Search contacts
GET /v1/organizations            — List companies
GET /v1/activities               — List activities (calls, meetings, tasks)
GET /v1/pipelines                — List pipelines
GET /v1/stages                   — List stages in pipeline
GET /v1/dealFields               — Custom field definitions
```

## Rate Limits

- Daily budget: 30,000 tokens x plan multiplier x seats
- Burst: rolling 2-second window
- Search: 10 req/2sec per token
- v2 endpoints cost 30-50% fewer tokens than v1
