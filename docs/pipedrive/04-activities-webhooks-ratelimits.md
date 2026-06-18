# Pipedrive API: Comprehensive Technical Reference

## Table of Contents

1. [Activities API](#activities-api)
2. [Webhooks](#webhooks)
3. [Rate Limiting](#rate-limiting)

---

## Activities API

### Overview

Activities represent tasks, calls, meetings, emails, and other interactions in Pipedrive. Each activity can be of a specific type and assigned to users. Activities can be linked to deals, persons, organizations, and leads.

### List Activities

#### Endpoint: GET /v1/activities or GET /v2/activities

Retrieves a paginated list of all activities with optional filtering and sorting.

**Query Parameters:**

| Parameter | Type | Description | Notes |
|-----------|------|-------------|-------|
| `limit` | integer | Number of entries to return | Default: 100, Max: 500 |
| `sort` | string | Field to sort by | Supported: `id`, `update_time`, `add_time`, `due_date` |
| `sort_dir` | string | Sort direction | Values: `asc`, `desc` |
| `start` | integer | Pagination offset | For offset-based pagination |
| `user_id` | integer | Filter by owner user | Returns activities owned by specified user |
| `deal_id` | integer | Filter by deal | Returns activities linked to specified deal |
| `lead_id` | integer | Filter by lead | Returns activities linked to specified lead |
| `person_id` | integer | Filter by primary participant | Returns activities where person is primary participant |
| `org_id` | integer | Filter by organization | Returns activities linked to specified organization |
| `updated_after` | string (RFC3339) | Filter by update time (start) | Format: `2025-01-01T10:20:00Z` |
| `updated_before` | string (RFC3339) | Filter by update time (end) | Format: `2025-01-01T10:20:00Z` |

**Response Fields:**

Standard activity object containing:
- `id`: Activity identifier
- `type`: Activity type (call, meeting, task, email, lunch, deadline, or custom)
- `person_id`: Associated person ID
- `deal_id`: Associated deal ID
- `organization_id`: Associated organization ID
- `user_id`: Assigned user ID
- `add_time`: Creation timestamp
- `update_time`: Last modification timestamp
- `due_date`: Due date (if applicable)
- `due_time`: Due time (if applicable)
- `duration`: Activity duration
- `location`: Activity location (if applicable)
- `note`: Activity notes/description
- `subject`: Activity subject/title
- `done`: Completion status (0 = incomplete, 1 = complete)
- `active_flag`: Activity status flag

### Get Single Activity

#### Endpoint: GET /v1/activities/{id} or GET /v2/activities/{id}

Retrieves a specific activity by ID.

**Path Parameters:**
- `id`: Activity identifier (required)

**Response:** Single activity object with all standard fields.

### Activity Types

#### Available Built-in Types

1. **call** - Phone or video call
2. **meeting** - In-person or video meeting
3. **task** - Task or to-do item
4. **email** - Email communication
5. **lunch** - Lunch/meal activity
6. **deadline** - Deadline marker

#### Custom Activity Types

Organizations can create custom activity types via the ActivityTypes endpoint.

**Creating Custom Activity Types:**

**Endpoint:** POST /v1/activityTypes

**Request Parameters:**
- `name` (required): Display name for activity type
- `icon_key` (required): Icon identifier
- `color` (optional): 6-character HEX color (e.g., `FF5733`)

**Supported Icon Keys:**
- Standard: `task`, `email`, `meeting`, `deadline`, `call`, `lunch`, `calendar`
- Additional: Various custom icons available

**Important Notes:**
- The `key_string` (internal identifier) is auto-generated from the name
- `key_string` cannot be changed after creation
- Activities reference custom types via `Activity.type = ActivityType.key_string`

### Activity Fields Metadata

#### Endpoint: GET /v1/activityFields or GET /v1/activityFields/{id}

Returns metadata about all activity fields or a specific field in the company.

**Query Parameters:**
- `limit`: Items per page (default: 100, max: 500)
- `start`: Pagination offset

**Response Fields:**
- `id`: Field identifier
- `name`: Field display name
- `key`: Field machine name
- `type`: Field data type
- `mandatory`: Whether field is required
- `edit_flag`: Whether field can be edited
- `filter_flag`: Whether field can be filtered
- `important_flag`: Whether field is marked important

**Important Notes:**
- Custom fields are NOT available for activities (unlike deals, persons, organizations)
- Activity fields are standardized across the company

### Create Activity

#### Endpoint: POST /v1/activities or POST /v2/activities

Creates a new activity.

**Request Body Parameters:**
- `type` (required): Activity type key/string
- `subject` (required): Activity title
- `user_id` (recommended): Assigned user ID
- `due_date` (optional): Due date (YYYY-MM-DD format)
- `due_time` (optional): Due time (HH:MM format)
- `duration` (optional): Duration in minutes
- `note` (optional): Activity notes
- `location` (optional): Physical location
- `person_id` (optional): Associated person ID
- `deal_id` (optional): Associated deal ID
- `organization_id` (optional): Associated organization ID
- `done` (optional): Completion flag (0 or 1)

**Response:** Created activity object with assigned ID.

### Update Activity

#### Endpoint: PUT /v1/activities/{id} or PUT /v2/activities/{id}

Updates an existing activity.

**Path Parameters:**
- `id`: Activity identifier (required)

**Request Body:** Same parameters as creation (all optional).

**Response:** Updated activity object.

### Delete Activity

#### Endpoint: DELETE /v1/activities/{id}

Deletes an activity.

**Response:** Confirmation of deletion.

### Response Format Example

```json
{
  "success": true,
  "data": {
    "id": 1,
    "type": "call",
    "person_id": 123,
    "deal_id": 456,
    "organization_id": 789,
    "user_id": 10,
    "subject": "Client call",
    "note": "Discussed project requirements",
    "add_time": "2025-01-15T10:30:00Z",
    "update_time": "2025-01-15T10:30:00Z",
    "due_date": "2025-01-16",
    "due_time": "14:00",
    "duration": 30,
    "location": "Conference Room A",
    "done": 0,
    "active_flag": true
  },
  "related_objects": {
    "person": { ... },
    "deal": { ... },
    "organization": { ... },
    "user": { ... }
  }
}
```

---

## Webhooks

### Overview

Webhooks provide real-time notifications when events occur in Pipedrive. They enable event-driven integrations without polling.

**Webhook Versions:**
- **v1**: Legacy version (deprecated, being phased out)
- **v2**: Current recommended version (default from March 17, 2025)

### Creating Webhooks

#### Endpoint: POST /v1/webhooks

Creates a webhook subscription for a specific event.

**Request Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subscription_url` | string | Yes | HTTP endpoint to receive webhook events |
| `event_action` | string | Yes | Event trigger action |
| `event_object` | string | Yes | Entity type that triggers the event |
| `user_id` | integer | No | User ID for authorization (defaults to current user) |
| `version` | string | No | Webhook version (`"1.0"` or `"2.0"`, default: `"2.0"`) |

**Subscription URL Requirements:**
- Must be a valid HTTP/HTTPS endpoint
- Cannot be a Pipedrive API endpoint
- Must not redirect to another URL
- Should be publicly accessible or whitelisted

**Event Actions:**

| Action | Description |
|--------|-------------|
| `added` | Entity was created |
| `updated` | Entity was modified |
| `deleted` | Entity was removed |
| `merged` | Entity was merged into another (v1 only; v2 uses separate added/deleted) |

**Event Objects:**

| Object | Description |
|--------|-------------|
| `deal` | Sales deals |
| `person` | Contacts/persons |
| `organization` | Organizations/companies |
| `activity` | Activities/tasks |
| `note` | Notes |
| `pipeline` | Sales pipelines |
| `stage` | Pipeline stages |
| `user` | Team members |
| `product` | Products |
| `lead` | Leads (if advanced features enabled) |

**Event Combinations:**

Specify events using the pattern: `{action}.{object}`

Examples:
- `added.deal` - New deal created
- `updated.person` - Person record modified
- `deleted.organization` - Organization removed
- `*.deal` - All deal events
- `*.*` - All events

**Request Example:**

```json
{
  "subscription_url": "https://your-domain.com/webhooks/pipedrive",
  "event_action": "updated",
  "event_object": "deal",
  "user_id": 12345,
  "version": "2.0"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "company_id": 12345,
    "user_id": 12345,
    "subscription_url": "https://your-domain.com/webhooks/pipedrive",
    "event_action": "updated",
    "event_object": "deal",
    "user_authorization_required": false,
    "active": true,
    "add_time": "2025-01-15T10:30:00Z",
    "update_time": "2025-01-15T10:30:00Z",
    "last_delivery_time": null,
    "last_http_status": null,
    "signature_secret": "sig_xxx_yyy_zzz"
  }
}
```

### Webhook v1 vs v2 Comparison

#### Payload Structure Differences

**v1 Payload:**
```json
{
  "v": 1,
  "timestamp": 1234567890,
  "type": "updated",
  "object": "deal",
  "user": {
    "id": 12345,
    "name": "John Doe"
  },
  "data": {
    "id": 456,
    "title": "Large Deal",
    "value": 50000
  },
  "current": {
    "id": 456,
    "title": "Larger Deal",
    "value": 75000
  }
}
```

**v2 Payload Structure:**

```json
{
  "meta": {
    "id": "webhook_1_uuid_string",
    "webhook_id": 1,
    "webhook_owner_id": 12345,
    "type": "updated",
    "action": "updated",
    "entity": "deal",
    "entity_id": 456,
    "company_id": 99999,
    "user_id": 12345,
    "user_name": "John Doe",
    "timestamp": 1673345678000,
    "version": "2.0",
    "correlation_id": "corr_xyz_abc",
    "is_bulk_edit": false,
    "change_source": "web",
    "attempt": 1,
    "host": "api.pipedrive.com",
    "permitted_user_ids": [12345, 67890],
    "merged_to_id": null,
    "merged_from_id": null
  },
  "data": {
    "id": 456,
    "title": "Larger Deal",
    "value": 75000,
    "status": "won",
    "custom_fields": {
      "field_uuid_1": "custom_value_1",
      "field_uuid_2": "custom_value_2"
    }
  },
  "previous": {
    "title": "Large Deal",
    "value": 50000,
    "status": "open"
  }
}
```

#### Key Differences

| Aspect | v1 | v2 |
|--------|----|----|
| **Root Structure** | Direct fields | `meta`, `data`, `previous` blocks |
| **Custom Fields** | Mixed in with standard fields | Separate `custom_fields` object |
| **User ID Field** | Webhook owner ID | User who triggered the event |
| **Webhook Owner ID** | Not explicitly separated | `webhook_owner_id` in meta |
| **Merge Events** | Single `merged` event | Separate `deleted` and `added` events with `merged_to_id`/`merged_from_id` |
| **Previous Data** | `current` field | `previous` field (only changed fields) |
| **Metadata** | Minimal | Rich meta block with correlation, source, attempt info |

#### Merge Event Handling

**v1 Merge:**
Single webhook event when entities are merged.

**v2 Merge:**
Two separate webhooks:

1. **Deleted Webhook** (source entity):
```json
{
  "meta": {
    "action": "deleted",
    "entity": "deal",
    "entity_id": 123,
    "merged_to_id": 456
  }
}
```

2. **Updated Webhook** (target entity):
```json
{
  "meta": {
    "action": "updated",
    "entity": "deal",
    "entity_id": 456,
    "merged_from_id": 123
  },
  "data": { ... },
  "previous": { ... }
}
```

### Webhook Security & Verification

#### HMAC-SHA256 Signature Verification

**Critical Step:** Always verify webhook signatures before processing.

**Implementation Steps:**

1. **Retrieve the Secret**
   - Access Pipedrive Settings > Tools and apps > Webhooks
   - Copy the "Signature hash key" for your webhook
   - Alternatively, use the `signature_secret` from the webhook creation response

2. **Verify on Receipt**
   ```
   // Pseudocode
   1. Read X-Pipedrive-Signature header from request
   2. Get raw request body (before JSON parsing)
   3. Compute: HMAC-SHA256(raw_body, webhook_secret)
   4. Compare computed hash with header value (constant-time comparison)
   5. If match: process webhook; if not: reject with 401
   ```

3. **Important Implementation Details**
   - Use the **raw request body** (string), not parsed JSON
   - Common failure: hashing parsed JSON instead of raw text
   - Use a **constant-time comparison function** to prevent timing attacks
   - Most crypto libraries provide `timingSafeEqual()` or similar

**Implementation Examples:**

**Node.js/Express:**
```javascript
const crypto = require('crypto');

app.post('/webhooks/pipedrive', express.raw({type: 'application/json'}), (req, res) => {
  const signature = req.headers['x-pipedrive-signature'];
  const secret = process.env.PIPEDRIVE_WEBHOOK_SECRET;

  // Use raw body (not parsed)
  const rawBody = req.body.toString('utf-8');

  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison
  if (!crypto.timingSafeEqual(computed, signature)) {
    return res.status(401).send('Unauthorized');
  }

  const webhook = JSON.parse(rawBody);
  // Process webhook...
  res.sendStatus(200);
});
```

**Python:**
```python
import hmac
import hashlib
import json

@app.route('/webhooks/pipedrive', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Pipedrive-Signature')
    secret = os.getenv('PIPEDRIVE_WEBHOOK_SECRET')

    # Get raw body
    raw_body = request.get_data()

    # Compute HMAC
    computed = hmac.new(
        secret.encode(),
        raw_body,
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    if not hmac.compare_digest(computed, signature):
        return 'Unauthorized', 401

    webhook = json.loads(raw_body)
    # Process webhook...
    return 'OK', 200
```

#### Webhook Headers

**Request Headers Sent by Pipedrive:**

| Header | Description |
|--------|-------------|
| `X-Pipedrive-Signature` | HMAC-SHA256 signature for verification |
| `Content-Type` | `application/json` |
| `User-Agent` | `Pipedrive/<version>` |

#### Webhook Response Requirements

- **Status Code:** Return 2xx (200-299) to confirm successful delivery
- **Timeout:** Pipedrive will timeout after 30 seconds
- **Retry Logic:** Failed deliveries are retried with exponential backoff
- **Response Body:** Can be empty; Pipedrive ignores response body

### Listing and Managing Webhooks

#### Endpoint: GET /v1/webhooks

Lists all webhooks for the authenticated user's company.

**Query Parameters:**
- `start`: Pagination offset
- `limit`: Items per page (default: 100)

**Response:** Array of webhook objects.

#### Endpoint: GET /v1/webhooks/{id}

Retrieves details of a specific webhook.

#### Endpoint: DELETE /v1/webhooks/{id}

Removes a webhook subscription.

---

## Rate Limiting

### Overview

Pipedrive uses a token-based rate limiting system to manage API usage. This system allocates daily tokens to each company account, with each API request consuming a specific number of tokens.

### Token Budget Calculation

#### Formula

```
Daily Token Budget = 30,000 × Plan Multiplier × Number of Seats + Purchased Top-ups
```

**Components:**

1. **Base Tokens:** 30,000 per day per account
2. **Plan Multiplier:** Varies by subscription level
   - Typical range: 1x to 4x
   - Enterprise plans may have higher multipliers
3. **Seats:** Number of licensed users
4. **Top-ups:** Additional token packages purchased

**Example Calculations:**

- **Small Plan, 5 seats, no top-ups:**
  - 30,000 × 1.0 × 5 = 150,000 tokens/day

- **Professional Plan, 10 seats, 50,000 top-up tokens:**
  - 30,000 × 2.0 × 10 + 50,000 = 650,000 tokens/day

- **Enterprise Plan, 50 seats:**
  - 30,000 × 4.0 × 50 = 6,000,000 tokens/day

### Token Costs Per Endpoint

**Cost Structure:**

Endpoints are classified by complexity:
- **Lightweight Requests:** 1-2 tokens (e.g., Get single record)
- **Standard Requests:** 5-10 tokens (e.g., List records)
- **Heavy Requests:** 20-50+ tokens (e.g., Search, Complex updates)

**API v1 vs v2:**
- **API v2 endpoints** typically cost 30-50% less than equivalent v1 endpoints
- Recommended to migrate to v2 for better token efficiency

**Specific Endpoint Categories:**

| Category | Examples | Typical Cost |
|----------|----------|--------------|
| Get Single Record | GET /deals/{id} | 1-2 tokens |
| List Records | GET /deals (with pagination) | 5-10 tokens |
| Create Record | POST /deals | 5-10 tokens |
| Update Record | PUT /deals/{id} | 5-10 tokens |
| Delete Record | DELETE /deals/{id} | 1 token |
| Search | POST /itemSearch | 20-50+ tokens |
| Bulk Operations | Various | 20-100+ tokens |

**Check Documentation:** Token costs for each endpoint are listed in the official [Pipedrive API Reference](https://developers.pipedrive.com/docs/api/v1).

### Burst Rate Limits

#### 2-Second Window Limits

In addition to daily token budgets, burst limits prevent rapid token depletion:

- **Scope:** Per API token/access token within a company
- **Window:** Rolling 2-second window
- **Limit:** Varies by subscription plan
  - Typical range: 5-20 requests per 2 seconds

**Purpose:**
- Prevent single users from exhausting daily budget in seconds
- Protect server stability against spike attacks
- Encourage well-distributed request patterns

**Behavior:**
- Requests within burst limit: Processed immediately
- Excess requests: Returned with 429 Too Many Requests
- Retry-After header: Indicates seconds until retry

#### Search API Specific Limits

The Search API (`POST /v1/itemSearch`) has dedicated burst limits:
- **Burst Limit:** 10 requests per 2 seconds per token
- **Applies to:** All subscription plans equally
- **Note:** Consistent across plans (not multiplied by plan tier)

### Rate Limit Headers

#### Previous Headers (Deprecated)

The following headers were previously returned but are no longer provided:
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- `X-Daily-RateLimit-Token-Limit`
- `X-Daily-RateLimit-Token-Remaining`

**Note:** Pipedrive is working on adding current token usage percentage to future response headers.

#### Current Headers

As of recent API updates, Pipedrive no longer returns rate limit headers in responses. Developers should:
- Monitor rate limit responses (429 status)
- Check the `Retry-After` header in error responses
- Plan token budgets conservatively
- Use webhooks instead of polling where possible

#### Future Plans

Pipedrive plans to add:
- `X-Daily-RateLimit-Token-Percentage` (approximate remaining percentage)
- Other indicators of token budget usage

### Handling 429 Responses

#### Error Response Format

```json
{
  "success": false,
  "error": "Daily rate limit exceeded",
  "error_code": 429,
  "error_description": "You have reached your daily API token limit"
}
```

**Response Headers:**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 3600
```

The `Retry-After` header indicates seconds until the token budget resets (typically 24 hours from last reset).

#### Retry Strategy Best Practices

1. **Exponential Backoff:**
   ```
   Wait = min(2^attempt * base_delay, max_wait)
   base_delay = 1 second
   max_wait = Retry-After header value (if present) or 24 hours
   ```

2. **Detect 429 Early:**
   - Monitor token usage trends
   - Estimate token consumption before making requests
   - Implement request queuing

3. **Alternative Strategies:**
   - **Use Webhooks:** Receive real-time events instead of polling
   - **Upgrade Plan:** Increase daily token budget by upgrading subscription
   - **Buy Top-ups:** Purchase additional token packages
   - **Optimize Requests:**
     - Use API v2 (30-50% cheaper)
     - Request only needed fields
     - Batch operations where possible
     - Use pagination to avoid unnecessary data transfer

4. **Implementation Pattern:**

**Node.js:**
```javascript
const axios = require('axios');

const axiosInstance = axios.create({
  baseURL: 'https://api.pipedrive.com/v1',
  params: { api_token: process.env.PIPEDRIVE_API_TOKEN }
});

// Add response interceptor
axiosInstance.interceptors.response.use(
  response => response,
  async error => {
    if (error.response?.status === 429) {
      const retryAfter = parseInt(
        error.response.headers['retry-after'] || '3600'
      );
      console.warn(`Rate limited. Retrying after ${retryAfter}s`);

      // Wait and retry
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return axiosInstance(error.config);
    }
    return Promise.reject(error);
  }
);
```

### Optimization Strategies

#### 1. Use API v2
- 30-50% lower token costs
- Better performance
- More modern response format

**Example:**
```
GET /v1/deals → 10 tokens
GET /v2/deals → 5 tokens (50% savings)
```

#### 2. Efficient Pagination
- Request only needed records per page
- Use filters to reduce result set size

**Example:**
```
GET /v1/deals?limit=500&status=open → Better than 100 individual requests
```

#### 3. Webhook-Driven Architecture
- Avoid polling in favor of webhooks
- Receive real-time notifications
- Reduces token consumption dramatically

**Cost Comparison:**
```
Polling 100 times/day: 100 × 10 tokens = 1,000 tokens/day
Webhooks: 0 tokens (after initial setup)
```

#### 4. Batch Operations
- Group multiple operations into single requests
- Use bulk create/update endpoints where available

#### 5. Selective Field Requests
- Request only necessary fields if API supports projection
- Reduces response size and processing time

#### 6. Caching
- Cache API responses locally when appropriate
- Reduce unnecessary re-fetching of static data

### Budget Monitoring

#### Manual Monitoring

1. Calculate daily budget using the formula above
2. Estimate token costs for your integration
3. Test token consumption in development
4. Monitor actual usage in production

#### Example Budget Planning

**Scenario:** Customer relationship management integration

```
- Sync 10,000 deals daily
  - List deals: 10 tokens × 1 call = 10 tokens
  - Per-deal operations: 2,000 items × 5 tokens = 10,000 tokens
  - Subtotal: 10,010 tokens

- Sync 50,000 persons
  - List persons: 10 tokens × 10 calls = 100 tokens
  - Per-person operations: 50,000 × 2 tokens = 100,000 tokens
  - Subtotal: 100,100 tokens

- Sync 500 activities
  - List activities: 10 tokens × 1 call = 10 tokens
  - Per-activity operations: 500 × 3 tokens = 1,500 tokens
  - Subtotal: 1,510 tokens

Daily Total: ~111,620 tokens

Budget Required: 111,620 ÷ 0.7 (safety margin) = 159,457 tokens
Recommendation: Professional plan with 10 seats = 600,000 tokens
Remaining: 440,343 tokens for ad-hoc operations
```

---

## Additional Resources

- [Pipedrive API v1 Activities Documentation](https://developers.pipedrive.com/docs/api/v1/Activities)
- [Pipedrive ActivityTypes API](https://developers.pipedrive.com/docs/api/v1/ActivityTypes)
- [Pipedrive ActivityFields API](https://developers.pipedrive.com/docs/api/v1/ActivityFields)
- [Pipedrive Webhooks v2 Guide](https://pipedrive.readme.io/docs/guide-for-webhooks-v2)
- [Pipedrive Webhooks v2 Migration Guide](https://pipedrive.readme.io/docs/webhooks-v2-migration-guide)
- [Pipedrive Rate Limiting Documentation](https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting)
- [Pipedrive API Optimization Guide](https://pipedrive.readme.io/docs/guide-for-optimizing-api-usage)
- [Pipedrive Developers Community](https://devcommunity.pipedrive.com/)

---

## Summary

### Key Takeaways

1. **Activities API:**
   - Use GET /v1/activities with filtering/sorting for list operations
   - Support for 6 built-in types + custom types
   - Activities can link to deals, persons, organizations, and leads
   - No custom fields available for activities (unlike other objects)

2. **Webhooks:**
   - Use v2 for new integrations (v1 being phased out)
   - Combine event_action + event_object for precise subscriptions
   - **Always verify HMAC-SHA256 signatures** before processing
   - v2 provides richer metadata and better merge event handling

3. **Rate Limiting:**
   - Daily token budget: 30,000 × plan multiplier × seats
   - Each endpoint costs specific tokens; v2 is 30-50% cheaper
   - Burst limits: Rolling 2-second window per token
   - 429 response: Use Retry-After header and implement backoff
   - Best practices: Use v2, webhooks, pagination, and caching

