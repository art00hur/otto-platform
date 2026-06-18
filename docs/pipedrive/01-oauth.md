# Pipedrive OAuth 2.0 Complete Technical Reference

## 1. Overview

Pipedrive implements the **OAuth 2.0 Authorization Code Flow**. This is the recommended authentication method for all apps.

### OAuth Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `https://oauth.pipedrive.com/oauth/authorize` | GET | User authorization |
| `https://oauth.pipedrive.com/oauth/token` | POST | Token exchange and refresh |
| `https://oauth.pipedrive.com/oauth/revoke` | POST | Token revocation |

---

## 2. Registering an App

1. Log in to **developer sandbox account** on Pipedrive
2. Navigate to **Settings > Developer Hub**
3. Create new app, provide name and **OAuth Callback URL**
4. Go to **"OAuth & access scopes"** tab to get credentials

**Credentials:**
- **Client ID** (`client_id`): Public identifier
- **Client Secret** (`client_secret`): Confidential, server-side only

**Rules:**
- One Callback URL per app
- Must be HTTPS
- Can update anytime before Marketplace submission

---

## 3. Authorization Flow

### Step 1: Redirect user to Pipedrive

```
GET https://oauth.pipedrive.com/oauth/authorize
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `client_id` | Yes | Your app's client ID |
| `redirect_uri` | Yes | Must match registered callback |
| `state` | Recommended | Random string for CSRF protection |
| `scope` | Optional | Space-separated scopes (e.g. `deals:read contacts:read`) |

**Example:**
```
https://oauth.pipedrive.com/oauth/authorize?client_id=YOUR_ID&redirect_uri=https%3A%2F%2Fotto-ai.co%2Fapi%2Fintegrations%2Fpipedrive%2Fcallback&state=abc123&scope=deals%3Aread%20contacts%3Aread%20activities%3Aread
```

### Step 2: User authorizes, Pipedrive redirects back

```
https://otto-ai.co/api/integrations/pipedrive/callback?code=AUTH_CODE&state=abc123
```

### Step 3: Exchange code for tokens

```
POST https://oauth.pipedrive.com/oauth/token
```

**Headers:**
```
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

**Body:**
```
grant_type=authorization_code&code=AUTH_CODE&redirect_uri=https://otto-ai.co/api/integrations/pipedrive/callback
```

**Response (200 OK):**
```json
{
  "access_token": "53:179:6317ef33a9fb0c4d604ce0695dad44c9",
  "token_type": "Bearer",
  "expires_in": 3599,
  "refresh_token": "53:179:5de81994d77491d22bc10eab3bc0810f84864297",
  "scope": "deals:read,contacts:read",
  "api_domain": "https://companyname.pipedrive.com"
}
```

**Critical fields in response:**
- `access_token`: Use as `Authorization: Bearer <token>` for API calls
- `expires_in`: 3599 seconds (~1 hour)
- `refresh_token`: Used to get new access_token
- `api_domain`: Base URL for this client's API calls (includes company subdomain)

---

## 4. Refresh Token Flow

Access tokens expire after ~1 hour. Refresh proactively (5min before expiry).

```
POST https://oauth.pipedrive.com/oauth/token
```

**Headers:**
```
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

**Body:**
```
grant_type=refresh_token&refresh_token=STORED_REFRESH_TOKEN
```

**Response:** Same format as initial token exchange (new access_token + new refresh_token).

**Refresh token lifetime:** 60 days of inactivity. Resets each time used. If expired, user must re-authorize.

---

## 5. Making API Requests

```bash
curl "https://companyname.pipedrive.com/api/v1/deals" \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

**Important:** Use the `api_domain` from the token response as base URL. Each client has a different company domain.

---

## 6. Available Scopes

### Read-Only Scopes (for Otto)

| Scope | Description |
|-------|-------------|
| `deals:read` | Read deal data |
| `contacts:read` | Read persons/contacts data |
| `activities:read` | Read activity data |
| `leads:read` | Read lead data |
| `products:read` | Read product data |
| `projects:read` | Read project data |
| `mail:read` | Read email data |

### Write Scopes (not used by Otto)

| Scope | Description |
|-------|-------------|
| `deals:full` | Read + write deals |
| `contacts:full` | Read + write contacts |
| `activities:full` | Read + write activities |
| `leads:full` | Read + write leads |
| `webhooks:full` | Create/delete webhooks |
| `admin` | Full admin access |

**Scope request format (space-separated in URL):**
```
scope=deals%3Aread%20contacts%3Aread%20activities%3Aread%20leads%3Aread
```

---

## 7. Token Revocation

```
POST https://oauth.pipedrive.com/oauth/revoke
```

**Headers:** Same Basic auth as token exchange.

**Body:**
```
token=ACCESS_OR_REFRESH_TOKEN
```

**Revoking access_token:** Only access_token invalidated, refresh_token remains valid.
**Revoking refresh_token:** All tokens invalidated, app marked "uninstalled", user must re-auth.

---

## 8. Error Handling

| HTTP Code | Error | Cause |
|-----------|-------|-------|
| 400 | `invalid_grant` | Auth code expired/reused, or refresh token expired |
| 400 | `invalid_request` | Missing required parameter |
| 401 | `invalid_client` | Bad client_id/secret or wrong Basic auth encoding |
| 401 | Unauthorized | Access token expired (refresh it) |
| 403 | Forbidden | Token lacks required scope |
| 429 | Rate limited | Too many requests (see rate limits doc) |

---

## 9. Node.js Implementation Reference

```typescript
// Generate authorization URL
function getAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: "deals:read contacts:read activities:read leads:read"
  });
  return `https://oauth.pipedrive.com/oauth/authorize?${params}`;
}

// Exchange code for tokens
async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://oauth.pipedrive.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  return res.json();
}

// Refresh access token
async function refreshToken(clientId: string, clientSecret: string, refreshToken: string) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://oauth.pipedrive.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return res.json();
}

// Make authenticated API request
async function apiGet(apiDomain: string, endpoint: string, accessToken: string) {
  const res = await fetch(`${apiDomain}/api/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}
```
