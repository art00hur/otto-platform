# Pipedrive Persons & Organizations API Reference

## Table of Contents
1. [Persons API](#persons-api)
   - [List Persons](#list-persons-get-v1persons)
   - [Get Single Person](#get-single-person-get-v1personsid)
   - [Search Persons](#search-persons-get-v1personssearch)
   - [Create Person](#create-person-post-v1persons)
   - [Update Person](#update-person-put-v1personsid)
   - [Person Fields](#person-fields)
2. [Organizations API](#organizations-api)
   - [List Organizations](#list-organizations-get-v1organizations)
   - [Get Single Organization](#get-single-organization-get-v1organizationsid)
   - [Create Organization](#create-organization-post-v1organizations)
   - [Update Organization](#update-organization-put-v1organizationsid)
   - [Organization Fields](#organization-fields)
3. [ItemSearch API](#itemsearch-api)
4. [Field Types & Custom Fields](#field-types--custom-fields)
5. [Relations Between Persons & Organizations](#relations-between-persons--organizations)
6. [API v1 vs v2 Migration Guide](#api-v1-vs-v2-migration-guide)
7. [Pagination](#pagination)
8. [Error Handling](#error-handling)

---

## Persons API

### Overview
The Persons API allows you to manage contacts in your Pipedrive account. Each person can be associated with an organization and contains contact information like email, phone, and custom fields.

**Base URL:** `https://api.pipedrive.com/v1/persons`

---

### List Persons (GET `/v1/persons`)

**Endpoint:** `GET https://api.pipedrive.com/v1/persons`

**Description:** Returns data about all persons, with optional filtering and pagination.

#### Query Parameters

| Parameter | Type | Default | Max Value | Description |
|-----------|------|---------|-----------|-------------|
| `user_id` | integer | - | - | If supplied, only persons owned by the specified user are returned |
| `filter_id` | integer | - | - | ID of a pre-defined filter to apply. If filter_id is provided, other filter parameters are ignored |
| `start` | integer | 0 | - | Pagination offset. Used with `limit` for offset-based pagination |
| `limit` | integer | 100 | 500 | The maximum number of entries to be returned per request |
| `sort_by` | string | `add_time` | - | Sort field. Allowed values: `id`, `add_time`, `update_time` |
| `sort_direction` | string | `asc` | - | Sort direction. Allowed values: `asc`, `desc` |
| `updated_since` | string (RFC3339) | - | - | Only return persons with update_time later than or equal to this time. Format: `2025-01-01T10:20:00Z` |
| `custom_fields` | string (comma-separated) | - | 15 fields max | Optional comma-separated list of custom field keys to include. Speeds up response and reduces payload |

#### Cursor-Based Pagination (Newer Endpoints)

**Note:** GET `/v2/persons` endpoint supports modern cursor-based pagination (more efficient for large collections):
- `cursor` - pagination cursor
- `limit` - items per page

#### Example Request

```bash
GET https://api.pipedrive.com/v1/persons?user_id=1&limit=50&sort_by=update_time&sort_direction=desc&api_token=YOUR_TOKEN
```

#### Example Response

```json
{
  "success": true,
  "data": [
    {
      "id": 123456,
      "name": "John Doe",
      "first_name": "John",
      "last_name": "Doe",
      "email": [
        {
          "value": "john.doe@example.com",
          "primary": true
        }
      ],
      "phone": [
        {
          "value": "+1234567890",
          "primary": true
        }
      ],
      "org_id": 987654,
      "org_name": "ACME Corp",
      "owner_id": 42,
      "add_time": "2025-01-15 10:30:00",
      "update_time": "2025-03-20 15:45:30",
      "active_flag": true,
      "notes": "Important contact",
      "birthday": "1990-05-10",
      "job_title": "Sales Manager",
      "custom_fields": {
        "field_key_hash": "custom_value"
      }
    }
  ],
  "additional_data": {
    "pagination": {
      "start": 0,
      "limit": 50,
      "more_items_in_collection": false,
      "next_start": null
    }
  }
}
```

---

### Get Single Person (GET `/v1/persons/:id`)

**Endpoint:** `GET https://api.pipedrive.com/v1/persons/:id`

**Description:** Returns detailed information about a specific person by ID.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | The ID of the person to retrieve |

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `custom_fields` | string (comma-separated) | Optional comma-separated list of custom field keys to include (v2 only, max 15) |
| `include_fields` | string (comma-separated) | Optional fields to include that are not in the default response (v2 only) |

#### Example Request

```bash
GET https://api.pipedrive.com/v1/persons/123456?api_token=YOUR_TOKEN
```

#### Example Response (Same as list item above)

---

### Search Persons (GET `/v1/persons/search`)

**Endpoint:** `GET https://api.pipedrive.com/v1/persons/search`

**Description:** Searches all persons by name, email, phone, notes, and/or custom fields. This is a wrapper around `/v1/itemSearch` with narrower OAuth scope.

#### Query Parameters

| Parameter | Type | Required | Constraints | Description |
|-----------|------|----------|-------------|-------------|
| `term` | string | Yes | Min 2 chars (1 if `exact_match=true`) | The search term to look for (URL encoded) |
| `fields` | string (comma-separated) | No | - | Which fields to search in. Defaults to all searchable fields. Searchable field types: address, varchar, text, varchar_auto, double, monetary, phone |
| `exact_match` | boolean | No | - | When true, only exact full matches are returned (case insensitive) |
| `org_id` | integer | No | - | Filter results to persons linked to a specific organization ID (max 2000 results per org) |
| `custom_fields` | string (comma-separated) | No | Max 15 fields | Specific custom field keys to include in response |
| `limit` | integer | No | Max 100 | Items shown per page |
| `start` | integer | No | - | Pagination offset |

#### What the Endpoint Searches

- Person name
- Email addresses
- Phone numbers
- Notes field
- Custom fields (only searchable types: address, varchar, text, varchar_auto, double, monetary, phone)

#### Example Request

```bash
GET https://api.pipedrive.com/v1/persons/search?term=john&exact_match=false&limit=25&api_token=YOUR_TOKEN

GET https://api.pipedrive.com/v1/persons/search?term=john@example.com&fields=email&org_id=987654&api_token=YOUR_TOKEN
```

#### Example Response

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "result_score": 0.95,
        "person": {
          "id": 123456,
          "name": "John Doe",
          "email": [{"value": "john@example.com", "primary": true}],
          "phone": [{"value": "+1234567890", "primary": true}],
          "org_id": 987654
        }
      }
    ],
    "pagination": {
      "start": 0,
      "limit": 25,
      "more_items_in_collection": false
    }
  }
}
```

---

### Create Person (POST `/v1/persons`)

**Endpoint:** `POST https://api.pipedrive.com/v1/persons`

**Description:** Creates a new person record.

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | The person's name |
| `email` | array of objects | No | Email address(es). Format: `[{"value": "email@example.com", "primary": true}]` |
| `phone` | array of objects | No | Phone number(s). Format: `[{"value": "+1234567890", "primary": true}]` |
| `org_id` | integer | No | ID of the organization the person belongs to |
| `owner_id` | integer | No | ID of the user who owns this person |
| `notes` | string | No | Notes about the person |
| `birthday` | string | No | Birthday in YYYY-MM-DD format |
| `job_title` | string | No | Job title (only if contact sync enabled) |
| `first_name` | string | No | First name (alternative to name) |
| `last_name` | string | No | Last name (alternative to name) |
| `custom_fields` | object | No | Custom field values as key-value pairs |

#### Example Request

```bash
curl -X POST https://api.pipedrive.com/v1/persons \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": [{"value": "john.doe@example.com", "primary": true}],
    "phone": [{"value": "+1234567890", "primary": true}],
    "org_id": 987654,
    "owner_id": 42,
    "notes": "Key account contact"
  }' \
  -G --data-urlencode "api_token=YOUR_TOKEN"
```

#### Example Response

```json
{
  "success": true,
  "data": {
    "id": 123456,
    "company_id": 1,
    "owner_id": 42,
    "org_id": 987654,
    "name": "John Doe",
    "first_name": "John",
    "last_name": "Doe",
    "email": [{"value": "john.doe@example.com", "primary": true}],
    "phone": [{"value": "+1234567890", "primary": true}],
    "add_time": "2025-03-20 10:30:00",
    "update_time": "2025-03-20 10:30:00",
    "active_flag": true
  }
}
```

---

### Update Person (PUT `/v1/persons/:id`)

**Endpoint:** `PUT https://api.pipedrive.com/v1/persons/:id`

**Description:** Updates an existing person's information.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | The ID of the person to update |

#### Request Body

Same fields as Create Person (all optional for updates).

#### Example Request

```bash
curl -X PUT https://api.pipedrive.com/v1/persons/123456 \
  -H "Content-Type: application/json" \
  -d '{
    "email": [{"value": "newemail@example.com", "primary": true}],
    "notes": "Updated note"
  }' \
  -G --data-urlencode "api_token=YOUR_TOKEN"
```

---

### Person Fields

#### Core Fields

| Field | Type | Searchable | Notes |
|-------|------|-----------|-------|
| `id` | integer | - | Unique identifier (read-only) |
| `name` | string | Yes | Full name or first/last name |
| `first_name` | string | Yes | First name |
| `last_name` | string | Yes | Last name |
| `email` | array | Yes | Array of email objects: `[{"value": "email@example.com", "primary": true}]` |
| `phone` | array | Yes | Array of phone objects: `[{"value": "+number", "primary": true}]` |
| `org_id` | integer | No | Organization ID |
| `owner_id` | integer | No | Owner user ID |
| `org_name` | string | No | Organization name (read-only) |
| `company_id` | integer | No | Company ID (read-only) |

#### Optional Fields

| Field | Type | Contact Sync Required | Notes |
|-------|------|----------------------|-------|
| `notes` | string | No | Notes about the person |
| `birthday` | string | No | Date in YYYY-MM-DD format |
| `job_title` | string | Yes | Job title |
| `im` | array | Yes | Instant messenger contacts (array with labels: Google, AIM, Yahoo, Skype, etc.) |
| `postal_address` | object | Yes | Address components |

#### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `add_time` | string | Creation timestamp (read-only) |
| `update_time` | string | Last update timestamp (read-only) |
| `active_flag` | boolean | Activity status (true = active, false = archived/deleted) |
| `custom_fields` | object | Custom field key-value pairs |

#### Custom Fields

Each company can have different custom field schemas. Custom field keys are randomly generated 40-character hashes, e.g., `dcf558aac1ae4e8c4f849ba5e668430d8df9be12`.

Searchable custom field types:
- address
- varchar
- text
- varchar_auto
- double
- monetary
- phone

Monetary fields have additional `_currency` field:
- `fieldkey_value` - numeric value
- `fieldkey_currency` - ISO currency code

---

## Organizations API

### Overview
The Organizations API allows you to manage company/organization records. Organizations can have multiple persons (contacts) associated with them.

**Base URL:** `https://api.pipedrive.com/v1/organizations`

---

### List Organizations (GET `/v1/organizations`)

**Endpoint:** `GET https://api.pipedrive.com/v1/organizations`

**Description:** Returns data about all organizations with optional filtering and pagination.

#### Query Parameters

| Parameter | Type | Default | Max Value | Description |
|-----------|------|---------|-----------|-------------|
| `user_id` | integer | - | - | If supplied, only organizations owned by the specified user are returned |
| `filter_id` | integer | - | - | ID of a pre-defined filter to apply. If filter_id is provided, other filter parameters are ignored |
| `start` | integer | 0 | - | Pagination offset. Used with `limit` for offset-based pagination |
| `limit` | integer | 100 | 500 | The maximum number of entries to be returned per request |
| `sort_by` | string | `add_time` | - | Sort field. Allowed values: `id`, `add_time`, `update_time` |
| `sort_direction` | string | `asc` | - | Sort direction. Allowed values: `asc`, `desc` |
| `updated_since` | string (RFC3339) | - | - | Only return organizations with update_time later than or equal to this time. Format: `2025-01-01T10:20:00Z` |
| `custom_fields` | string (comma-separated) | - | 15 fields max | Optional comma-separated list of custom field keys to include |

#### Cursor-Based Pagination (v2)

**Note:** GET `/v2/organizations` supports cursor-based pagination:
- `cursor` - pagination cursor
- `limit` - items per page

#### Example Request

```bash
GET https://api.pipedrive.com/v1/organizations?limit=50&sort_by=update_time&sort_direction=desc&api_token=YOUR_TOKEN
```

#### Example Response

```json
{
  "success": true,
  "data": [
    {
      "id": 987654,
      "name": "ACME Corp",
      "owner_id": 42,
      "address": "123 Business St, Suite 100",
      "country_code": "US",
      "postal_code": "10001",
      "add_time": "2024-06-10 09:15:00",
      "update_time": "2025-03-15 14:20:30",
      "active_flag": true,
      "notes": "Major client",
      "custom_fields": {
        "field_key_hash": "custom_value"
      }
    }
  ],
  "additional_data": {
    "pagination": {
      "start": 0,
      "limit": 50,
      "more_items_in_collection": false
    }
  }
}
```

---

### Get Single Organization (GET `/v1/organizations/:id`)

**Endpoint:** `GET https://api.pipedrive.com/v1/organizations/:id`

**Description:** Returns detailed information about a specific organization by ID.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | The ID of the organization to retrieve |

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `custom_fields` | string (comma-separated) | Optional comma-separated list of custom field keys to include (v2 only, max 15) |
| `include_fields` | string (comma-separated) | Optional fields to include that are not in the default response (v2 only) |

#### Example Request

```bash
GET https://api.pipedrive.com/v1/organizations/987654?api_token=YOUR_TOKEN
```

---

### Search Organizations

**Endpoint:** `GET https://api.pipedrive.com/v1/organizations/search`

**Description:** Searches all organizations by name, address, notes, and/or custom fields. This is a wrapper around `/v1/itemSearch` with narrower OAuth scope.

#### Query Parameters

| Parameter | Type | Required | Constraints | Description |
|-----------|------|----------|-------------|-------------|
| `term` | string | Yes | Min 2 chars (1 if `exact_match=true`) | The search term to look for (URL encoded) |
| `fields` | string (comma-separated) | No | - | Which fields to search in. Defaults to all searchable fields |
| `exact_match` | boolean | No | - | When true, only exact full matches are returned (case insensitive) |
| `custom_fields` | string (comma-separated) | No | Max 15 fields | Specific custom field keys to include in response |
| `limit` | integer | No | Max 100 | Items shown per page |
| `start` | integer | No | - | Pagination offset |

#### What the Endpoint Searches

- Organization name
- Address fields
- Notes
- Custom fields (searchable types only)

#### Example Request

```bash
GET https://api.pipedrive.com/v1/organizations/search?term=ACME&exact_match=false&limit=10&api_token=YOUR_TOKEN
```

---

### Create Organization (POST `/v1/organizations`)

**Endpoint:** `POST https://api.pipedrive.com/v1/organizations`

**Description:** Creates a new organization record.

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | The organization's name (ONLY required field) |
| `address` | object | No | Address components (see address structure below) |
| `country_code` | string | No | 2-letter country code (e.g., "US", "GB") |
| `postal_code` | string | No | Postal/zip code |
| `owner_id` | integer | No | ID of the user who owns this organization |
| `notes` | string | No | Notes about the organization |
| `custom_fields` | object | No | Custom field values as key-value pairs |

#### Address Structure

```json
{
  "address": {
    "subpremise": "Suite 100",
    "street_number": "123",
    "route": "Business St",
    "sublocality": "Downtown",
    "locality": "New York",
    "admin_area_level_1": "NY",
    "admin_area_level_2": "New York County",
    "country": "United States",
    "postal_code": "10001",
    "formatted_address": "123 Business St, Suite 100, New York, NY 10001, United States"
  }
}
```

Note: Only the `value` subfield is required when updating an address; all other subfields are optional and default to null if not provided.

#### Example Request

```bash
curl -X POST https://api.pipedrive.com/v1/organizations \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ACME Corp",
    "address": {
      "street_number": "123",
      "route": "Business St",
      "locality": "New York",
      "admin_area_level_1": "NY",
      "postal_code": "10001",
      "country": "United States"
    },
    "owner_id": 42,
    "notes": "Major client account"
  }' \
  -G --data-urlencode "api_token=YOUR_TOKEN"
```

#### Example Response

```json
{
  "success": true,
  "data": {
    "id": 987654,
    "company_id": 1,
    "owner_id": 42,
    "name": "ACME Corp",
    "address": "123 Business St, New York, NY 10001",
    "country_code": "US",
    "postal_code": "10001",
    "add_time": "2025-03-20 10:30:00",
    "update_time": "2025-03-20 10:30:00",
    "active_flag": true
  }
}
```

---

### Update Organization (PUT `/v1/organizations/:id`)

**Endpoint:** `PUT https://api.pipedrive.com/v1/organizations/:id`

**Description:** Updates an existing organization's information.

#### URL Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | The ID of the organization to update |

#### Request Body

Same fields as Create Organization (all optional for updates).

#### Example Request

```bash
curl -X PUT https://api.pipedrive.com/v1/organizations/987654 \
  -H "Content-Type: application/json" \
  -d '{
    "address": "456 New Ave, New York, NY 10002",
    "notes": "Updated contact details"
  }' \
  -G --data-urlencode "api_token=YOUR_TOKEN"
```

---

### Organization Fields

#### Core Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | integer | Unique identifier (read-only) |
| `name` | string | Organization name |
| `address` | object/string | Full address or address components object |
| `country_code` | string | 2-letter country code |
| `postal_code` | string | Postal/zip code |
| `owner_id` | integer | Owner user ID |
| `company_id` | integer | Company ID (read-only) |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `notes` | string | Notes about the organization |
| `custom_fields` | object | Custom field key-value pairs |

#### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `add_time` | string | Creation timestamp (read-only) |
| `update_time` | string | Last update timestamp (read-only) |
| `active_flag` | boolean | Activity status |

#### Address Components

When address is returned as an object, it includes:
- `subpremise` - Suite, apartment number, etc.
- `street_number` - Street number
- `route` - Street name
- `sublocality` - Neighborhood or area
- `locality` - City/town
- `admin_area_level_1` - State/province
- `admin_area_level_2` - County/district
- `country` - Full country name
- `postal_code` - Zip/postal code
- `formatted_address` - Complete formatted address

#### Custom Fields

Organizations can have custom fields using the same structure as persons:
- Keys are 40-character hashes
- Same searchable field types as persons
- Monetary fields have `_currency` suffix

---

## ItemSearch API

### Overview
A unified search endpoint that searches across multiple item types (persons, organizations, deals, leads, products, files, mail attachments).

**Endpoint:** `GET https://api.pipedrive.com/v1/itemSearch`

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `term` | string | Yes | Search term (min 2 chars, 1 with exact_match) |
| `item_type` | string | No | Comma-separated item types to search: person, organization, deal, lead, product, file, mail_attachment |
| `fields` | string | No | Comma-separated fields to search in |
| `exact_match` | boolean | No | Only exact matches (case insensitive) |
| `limit` | integer | No | Max 100, default varies |
| `start` | integer | No | Pagination offset |
| `include_fields` | string | No | Include additional fields (comma-separated) |

### Return Format

Returns ordered reference objects pointing to found items with result scores.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "type": "person",
        "id": 123456,
        "result_score": 0.95,
        "person": {...},
        "related_objects": {
          "deals": [...],
          "leads": [...]
        }
      }
    ]
  }
}
```

---

## Field Types & Custom Fields

### Standard Field Types

- `text` - Short text field
- `varchar` - Variable character field
- `varchar_auto` - Auto-completing text field
- `double` - Decimal number
- `monetary` - Currency amount (includes `_currency` field)
- `address` - Multi-part address field
- `phone` - Phone number (searchable in persons/orgs)
- `email` - Email address (array in persons)
- `date` - Date field
- `daterange` - Date range (includes additional range field)
- `timerange` - Time range (includes additional range field)

### Searchable Custom Field Types

- address
- varchar
- text
- varchar_auto
- double
- monetary
- phone

### Custom Field Naming

- All custom fields are referenced by 40-character hash keys
- Format: `dcf558aac1ae4e8c4f849ba5e668430d8df9be12`
- Retrieve available fields via PersonFields or OrganizationFields endpoints

### Multi-Part Fields

**Monetary Field Example:**
```json
{
  "custom_field_key": 1500.00,
  "custom_field_key_currency": "USD"
}
```

**Address Field Example (in custom fields):**
```json
{
  "address_field_key": {
    "subpremise": "Suite 100",
    "street_number": "123",
    "route": "Main St",
    "locality": "New York",
    "postal_code": "10001"
  }
}
```

---

## Relations Between Persons & Organizations

### Person-to-Organization Relationship

1. **Linking Persons to Organizations:**
   - Include `org_id` field when creating or updating a person
   - A person can only belong to one organization at a time
   - Organization name appears as `org_name` in person object (read-only)

2. **Finding Persons by Organization:**
   - Use `/v1/persons?org_id=987654` to list all persons in an organization
   - Use search with `org_id` filter: `/v1/persons/search?term=john&org_id=987654`
   - Legacy endpoint (deprecated): `/v1/organizations/:id/persons`

3. **Organization-Person Count:**
   - The organization object doesn't include a person count directly
   - Use list persons endpoint with org_id filter and check pagination total

### Data Structure Examples

**Person object with organization:**
```json
{
  "id": 123456,
  "name": "John Doe",
  "org_id": 987654,
  "org_name": "ACME Corp"
}
```

**Multiple persons in same organization:**
```bash
GET /v1/persons?org_id=987654
# Returns all persons where org_id = 987654
```

### Dealing with Orphaned Persons

- Persons without an organization have `org_id: null` or `org_id: 0`
- These persons still appear in general person lists
- Filter by `org_id` to exclude or include only unassigned persons

---

## API v1 vs v2 Migration Guide

### Overview

**Timeline:** API v1 will be deprecated on July 31, 2026. Migration to v2 is recommended.

### Key Changes

#### Boolean Fields

**v1:** Returns `0` (false) or `1` (true)
```json
{"active_flag": 1}
```

**v2:** Returns strict boolean values
```json
{"active_flag": true}
```

#### Field Name Changes

| Field | v1 | v2 |
|-------|----|----|
| Email field | `email` (array) | `emails` (array) |
| Phone field | `phone` (array) | `phones` (array) |
| IM field | `im` (array) | `ims` (array) |
| Active flag | `active_flag` | `is_deleted` (inverted - `is_deleted = !active_flag`) |

#### Timestamps

**v1:** Unix timestamps or formatted strings
```json
{"add_time": "2023-03-02 02:14:54"}
```

**v2:** RFC 3339 format with timezone
```json
{"add_time": "2023-03-02T02:14:54Z"}
```

#### Response Structure

**v1:** Includes related objects eagerly
```json
{
  "data": {
    "id": 123,
    "person": {...},
    "organization": {...},
    "deals": [...]
  }
}
```

**v2:** Related objects are NOT included by default
```json
{
  "data": {
    "id": 123,
    "organization_id": 456
  }
}
```

Use `include_fields` parameter to opt-in to additional fields.

#### Input Validation

**v1:** Coerces types (string to number)
```bash
{"limit": "50"}  # Accepted
```

**v2:** Strict type checking
```bash
{"limit": "50"}  # Error: must be integer
```

#### New Parameters

Both Persons and Organizations APIs in v2 include:

- **`custom_fields`** (query) - Return only specific custom fields (comma-separated, max 15)
- **`include_fields`** (query) - Include additional non-default fields (comma-separated)

#### Pagination Changes

**v1:** Offset-based
```bash
GET /v1/persons?start=0&limit=50
```

**v2:** Cursor-based (recommended)
```bash
GET /v2/persons?cursor=CURSOR_TOKEN&limit=50
```

Both versions support offset-based pagination in v2.

#### New Endpoints

- `GET /v2/persons` - Cursor-paginated list
- `GET /v2/organizations` - Cursor-paginated list

#### Deprecated Endpoints

- `GET /v1/organizations/:id/persons` - Use `GET /v1/persons?org_id=:id` instead

### Migration Checklist

- [ ] Update boolean field handling (1/0 → true/false)
- [ ] Update field names (email → emails, phone → phones, im → ims)
- [ ] Update timestamp parsing (RFC 3339 format)
- [ ] Handle response structure changes (no eager-loaded related objects)
- [ ] Use `include_fields` for previously included relations
- [ ] Implement strict type validation
- [ ] Consider migrating to cursor-based pagination
- [ ] Test thoroughly before July 31, 2026

---

## Pagination

### Offset-Based Pagination (v1 & v2)

Used in list endpoints with `start` and `limit` parameters.

```bash
GET /v1/persons?start=0&limit=50&api_token=TOKEN
```

**Response includes pagination metadata:**
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

**Parameters:**
- `start` (default: 0) - Result offset
- `limit` (default: 100, max: 500) - Results per page

**Iteration pattern:**
1. Start with `start=0, limit=50`
2. Check `more_items_in_collection`
3. If true, set `start=next_start` and fetch next page
4. Repeat until `more_items_in_collection=false`

### Cursor-Based Pagination (v2 Recommended)

More efficient for large datasets.

```bash
GET /v2/persons?cursor=INITIAL_CURSOR&limit=50&api_token=TOKEN
```

**Response includes cursor:**
```json
{
  "data": [...],
  "additional_data": {
    "pagination": {
      "cursor": "NEXT_CURSOR",
      "more_items_in_collection": true
    }
  }
}
```

**Parameters:**
- `cursor` - Pagination token (string)
- `limit` - Results per page

**Iteration pattern:**
1. Initial request without cursor
2. Use returned cursor for next request
3. Continue until `more_items_in_collection=false`

### Best Practices

- **For small result sets:** Use offset-based pagination (simpler)
- **For large result sets:** Use cursor-based pagination (more efficient)
- **Always respect `limit` max values** (500 for offset, varies for cursor)
- **Cache results locally** if possible to avoid repeated fetches
- **Implement exponential backoff** for rate limit handling

---

## Error Handling

### Common HTTP Status Codes

| Code | Meaning | Reason |
|------|---------|--------|
| 200 | OK | Request successful |
| 400 | Bad Request | Invalid parameters or malformed JSON |
| 401 | Unauthorized | Missing or invalid API token |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource doesn't exist |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Server Error | Pipedrive server error |

### Response Format

**Success Response:**
```json
{
  "success": true,
  "data": {...},
  "additional_data": {...}
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "error_message",
  "error_code": "error_code"
}
```

### Common Error Codes

| Code | Cause | Solution |
|------|-------|----------|
| `INVALID_REQUEST` | Missing required fields | Check required parameters |
| `INVALID_TOKEN` | Token missing or invalid | Verify API token |
| `NOT_FOUND` | Resource doesn't exist | Check ID/parameters |
| `UNAUTHORIZED_ACTION` | User lacks permission | Verify user permissions |
| `VALIDATION_ERROR` | Input validation failed | Check field types and formats |
| `RATE_LIMIT_EXCEEDED` | Too many requests | Implement backoff/queuing |

### Rate Limiting

- **Limit:** 500 requests per second (standard plan may vary)
- **Response headers:** Include `X-RateLimit-*` headers
- **Strategy:** Implement exponential backoff and request queuing

---

## API Authentication

All requests require an API token passed as query parameter:

```bash
GET /v1/persons?api_token=YOUR_TOKEN
```

Or as header (depends on endpoint implementation):
```bash
Authorization: Bearer YOUR_TOKEN
```

### Obtaining an API Token

1. Log in to Pipedrive
2. Navigate to Settings → Personal → API
3. Copy your personal API token
4. Use in all requests

### Token Best Practices

- Never expose tokens in client-side code
- Use environment variables for token storage
- Implement token rotation periodically
- Log API usage for debugging
- Consider rate limiting at application level

---

## Summary Table: API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/persons` | List all persons |
| GET | `/v1/persons/:id` | Get single person |
| GET | `/v1/persons/search` | Search persons |
| POST | `/v1/persons` | Create person |
| PUT | `/v1/persons/:id` | Update person |
| DELETE | `/v1/persons/:id` | Delete person |
| GET | `/v1/organizations` | List all organizations |
| GET | `/v1/organizations/:id` | Get single organization |
| GET | `/v1/organizations/search` | Search organizations |
| POST | `/v1/organizations` | Create organization |
| PUT | `/v1/organizations/:id` | Update organization |
| DELETE | `/v1/organizations/:id` | Delete organization |
| GET | `/v1/itemSearch` | Search across item types |
| GET | `/v1/personFields` | Get available person field schemas |
| GET | `/v1/organizationFields` | Get available organization field schemas |

---

## References & Documentation

- [Official Pipedrive API Persons Endpoint](https://developers.pipedrive.com/docs/api/v1/Persons)
- [Official Pipedrive API Organizations Endpoint](https://developers.pipedrive.com/docs/api/v1/Organizations)
- [Pipedrive API v2 Migration Guide](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide)
- [Pipedrive Pagination Documentation](https://pipedrive.readme.io/docs/core-api-concepts-pagination)
- [Custom Fields Documentation](https://pipedrive.readme.io/docs/core-api-concepts-custom-fields)
- [ItemSearch API](https://developers.pipedrive.com/docs/api/v1/ItemSearch)
- [PersonFields Reference](https://developers.pipedrive.com/docs/api/v1/PersonFields)
- [OrganizationFields Reference](https://developers.pipedrive.com/docs/api/v1/OrganizationFields)

