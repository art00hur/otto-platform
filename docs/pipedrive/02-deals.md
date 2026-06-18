# Pipedrive Deals API Reference

## Overview

Deals represent ongoing, lost, or won sales. Each deal has a monetary value and belongs to a pipeline stage.

---

## List Deals

### GET /v2/deals (recommended)

```
GET https://{api_domain}/api/v2/deals
```

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 100 | 500 | Items per page |
| `cursor` | string | — | — | Pagination cursor from `additional_data.next_cursor` |
| `sort_by` | string | — | — | `id`, `update_time`, `add_time` |
| `sort_direction` | string | — | — | `asc`, `desc` |
| `owner_id` | integer | — | — | Filter by deal owner |
| `person_id` | integer | — | — | Filter by person |
| `org_id` | integer | — | — | Filter by organization |
| `pipeline_id` | integer | — | — | Filter by pipeline |
| `stage_id` | integer | — | — | Filter by stage |
| `status` | string | — | — | `open`, `won`, `lost`, `deleted` |
| `include_fields` | string | — | — | Comma-separated: `next_activity_id`, `last_activity_id`, `activities_count`, `done_activities_count`, `undone_activities_count`, `participants_count`, `products_count`, `files_count`, `notes_count`, `followers_count`, `email_messages_count`, `last_incoming_mail_time`, `last_outgoing_mail_time`, `first_won_time` |
| `custom_fields` | string | — | 15 max | Comma-separated custom field keys |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "1",
      "title": "Deal Title",
      "value": 50000,
      "currency": "EUR",
      "status": "open",
      "owner_id": "1",
      "person_id": "1",
      "org_id": "1",
      "pipeline_id": "1",
      "stage_id": "2",
      "expected_close_date": "2026-04-01",
      "add_time": "2026-01-01T12:00:00Z",
      "update_time": "2026-03-15T09:30:00Z",
      "stage_change_time": "2026-03-10T14:00:00Z",
      "probability": true,
      "visible_to": "3",
      "activities_count": 5,
      "notes_count": 3
    }
  ],
  "additional_data": {
    "pagination": {
      "next_cursor": "eyJkZWFscyI6NTB9"
    }
  }
}
```

### GET /v1/deals (legacy)

Same concept but uses offset-based pagination (`start`/`limit`) instead of cursor.

```
GET https://{api_domain}/api/v1/deals?start=0&limit=50&status=open&sort_by=update_time
```

**v1 pagination response:**
```json
{
  "additional_data": {
    "pagination": {
      "start": 0,
      "limit": 50,
      "more_items_in_collection": true,
      "next_start": 50
    }
  }
}
```

---

## Get Single Deal

### GET /v1/deals/:id

```
GET https://{api_domain}/api/v1/deals/123
```

Returns full deal object with all standard and custom fields.

---

## Search Deals

### GET /v1/deals/search

```
GET https://{api_domain}/api/v1/deals/search
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `term` | string | Yes | Min 2 chars (1 with `exact_match`) |
| `exact_match` | boolean | No | Only full exact matches |
| `person_id` | integer | No | Filter by person (max 2000 results) |
| `organization_id` | integer | No | Filter by org (max 2000 results) |
| `status` | string | No | `open`, `won`, `lost` |
| `limit` | integer | No | Default 100, max 500 |
| `fields` | string | No | Comma-separated field names to search in |

**Searchable field types:** `address`, `varchar`, `text`, `varchar_auto`, `double`, `monetary`, `phone`

**Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 1,
        "type": "deal",
        "result_score": 0.86,
        "title": "Acme Enterprise Deal",
        "value": 50000,
        "currency": "EUR",
        "status": "open",
        "stage_id": 2
      }
    ]
  }
}
```

---

## Deal Fields

### Standard Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (v2) / int (v1) | Unique identifier |
| `title` | string | Deal name |
| `value` | number | Monetary value |
| `currency` | string | ISO 4217 (EUR, USD...) |
| `status` | string | `open`, `won`, `lost`, `deleted` |
| `person_id` | string/int | Associated contact |
| `org_id` | string/int | Associated organization |
| `pipeline_id` | string/int | Pipeline |
| `stage_id` | string/int | Current stage |
| `owner_id` (v2) / `user_id` (v1) | string/int | Deal owner |
| `creator_user_id` | int | Who created it |
| `expected_close_date` | string | `YYYY-MM-DD` |
| `lost_reason` | string | If status = lost |
| `probability` | boolean (v2) / null (v1) | Win probability |
| `visible_to` | string | `1` (owner), `3` (team), `5` (company) |
| `add_time` | string | RFC 3339 in v2 |
| `update_time` | string | RFC 3339 in v2 |
| `stage_change_time` | string | When entered current stage |

### Custom Fields

Custom fields use hash keys (e.g. `a1b2c3d4e5f6`). Get field definitions:

```
GET /v1/dealFields
```

**Custom field types:** varchar, text, double, monetary (+ `_currency` suffix), date, daterange (+ `_end`), time, timerange, enum, set, org, people, user, address, phone

---

## Pipelines & Stages

### GET /v1/pipelines

```json
{
  "data": [
    { "id": 1, "name": "Sales", "active": true, "order_nr": 0 },
    { "id": 2, "name": "Enterprise", "active": true, "order_nr": 1 }
  ]
}
```

### GET /v1/stages

Filter by pipeline: `GET /v1/stages?pipeline_id=1`

```json
{
  "data": [
    { "id": 1, "pipeline_id": 1, "name": "Prospect", "order_nr": 1, "deal_probability": 20 },
    { "id": 2, "pipeline_id": 1, "name": "Negotiation", "order_nr": 2, "deal_probability": 50 },
    { "id": 3, "pipeline_id": 1, "name": "Closing", "order_nr": 3, "deal_probability": 80 }
  ]
}
```

---

## v1 vs v2 Key Differences

| Aspect | v1 | v2 |
|--------|----|----|
| Pagination | Offset (`start`/`limit`) | Cursor (`cursor`/`limit`) |
| Timestamps | Variable format | RFC 3339 |
| IDs | Integers | String numbers |
| Owner field | `user_id` | `owner_id` |
| Booleans | 0/1 | true/false |
| Related objects | Included inline | Removed (use include_fields) |
| Custom fields | Always returned | Use `custom_fields` param |

### v2 replaces nested v1 endpoints

| v1 | v2 equivalent |
|----|---------------|
| `GET /v1/persons/:id/deals` | `GET /v2/deals?person_id=...` |
| `GET /v1/organizations/:id/deals` | `GET /v2/deals?org_id=...` |
| `GET /v1/pipelines/:id/deals` | `GET /v2/deals?pipeline_id=...` |
| `GET /v1/stages/:id/deals` | `GET /v2/deals?stage_id=...` |

---

## Common Patterns

### Paginate all deals (v2)
```typescript
async function getAllDeals(apiDomain: string, token: string) {
  const deals = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "500" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiDomain}/api/v2/deals?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    deals.push(...json.data);
    cursor = json.additional_data?.pagination?.next_cursor;
  } while (cursor);
  return deals;
}
```

### Get deals by stage with activities count
```bash
curl "${API_DOMAIN}/api/v2/deals?stage_id=2&include_fields=activities_count,notes_count&sort_by=update_time&sort_direction=desc" \
  -H "Authorization: Bearer TOKEN"
```
