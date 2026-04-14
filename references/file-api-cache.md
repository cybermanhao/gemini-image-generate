# File API Caching

## Why

Uploading the same image as base64 inline on every generation call wastes bandwidth and adds latency. The Gemini File API lets you upload once, get a URI, and reference it for up to 48 hours. Cache the URI in your database.

---

## Upload

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function uploadImage(imageBase64: string): Promise<string | null> {
  const buffer = Buffer.from(imageBase64, 'base64');
  const blob = new Blob([buffer], { type: 'image/jpeg' });

  const uploaded = await ai.files.upload({
    file: blob,
    config: { mimeType: 'image/jpeg' },
  });

  return uploaded.uri ?? null;
}
```

---

## Cache Layer (DB-backed)

```typescript
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min safety margin

async function getOrUploadImage(
  ai: GoogleGenAI,
  imageId: number,           // your identifier
  imageBase64: string,
  db: Database,
): Promise<{ uri: string; hit: boolean } | null> {
  const now = Date.now();

  // Check DB cache
  const cached = db
    .prepare('SELECT file_uri, file_uri_expires_at FROM image_cache WHERE id = ?')
    .get(imageId) as { file_uri: string | null; file_uri_expires_at: number | null } | undefined;

  if (cached?.file_uri && (cached.file_uri_expires_at ?? 0) > now) {
    return { uri: cached.file_uri, hit: true };  // cache hit
  }

  // Upload
  const uri = await uploadImage(imageBase64);
  if (!uri) return null;

  // Compute TTL: use server's expirationTime if available, else 47h
  // Google expires files after 48h; we subtract the 5-min buffer
  const expiresAt = now + 47 * 60 * 60 * 1000;

  db.prepare(
    'UPDATE image_cache SET file_uri = ?, file_uri_expires_at = ? WHERE id = ?'
  ).run(uri, expiresAt, imageId);

  return { uri, hit: false };
}
```

**TTL logic:** Google's files expire after 48 hours from upload. Store `now + 47h` (subtract the 5-min buffer) so you never use a stale URI.

---

## Using the Cache in Parts

```typescript
const cached = await getOrUploadImage(ai, imageId, imageBase64, db).catch(() => null);

const inlinePart: Part = { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } };
const filePart: Part | null = cached
  ? { fileData: { fileUri: cached.uri, mimeType: 'image/jpeg' } }
  : null;

// Prefer File API, fallback to inline
const mainPartIdx = parts.length;
parts.push(filePart ?? inlinePart);
```

---

## Handling File API Errors (403 Fallback)

Cached URIs can become invalid before their TTL (e.g., file deleted server-side). Detect and recover:

```typescript
function isFileApiForbidden(err: unknown): boolean {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  const msg = String(e?.error?.message ?? e?.message ?? '');
  return (code === 403 || code === 'PERMISSION_DENIED') && msg.includes('File');
}

function invalidateCache(imageId: number, db: Database) {
  db.prepare('UPDATE image_cache SET file_uri = NULL, file_uri_expires_at = NULL WHERE id = ?')
    .run(imageId);
}
```

```typescript
try {
  response = await ai.models.generateContent({ model, contents, config });
} catch (err) {
  if (filePart && isFileApiForbidden(err)) {
    // Invalidate stale URI and retry with inline
    invalidateCache(imageId, db);
    parts[mainPartIdx] = inlinePart;
    response = await ai.models.generateContent({ model, contents, config });
  } else {
    throw err;
  }
}
```

---

## Retryable vs Fatal Errors

```typescript
function isRetryable(err: unknown): boolean {
  const e = err as Record<string, any>;
  const code = e?.error?.code ?? e?.status;
  if (code === 429 || code === 'RESOURCE_EXHAUSTED') return true;   // rate limit
  if (code === 503 || code === 'UNAVAILABLE') return true;           // transient
  const msg = String(e?.error?.message ?? '');
  return msg.includes('fetch failed') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');
}
```

| Code | Meaning | Action |
|------|---------|--------|
| 429 / RESOURCE_EXHAUSTED | Rate limit | Retry with backoff |
| 503 / UNAVAILABLE | Transient server error | Retry |
| fetch failed / ETIMEDOUT | Network | Retry |
| 403 + "File" | Stale File URI | Invalidate cache, retry with inline |
| 400 | Bad request (bad prompt, bad config) | Fatal, don't retry |
| 403 (no "File") | Auth / permission | Fatal |

---

## Invalidation

Invalidate the cached URI whenever the source image changes:

```typescript
function invalidateOnImageChange(imageId: number, db: Database) {
  db.prepare('UPDATE image_cache SET file_uri = NULL, file_uri_expires_at = NULL WHERE id = ?')
    .run(imageId);
}
```

Call this whenever the image content is replaced (e.g., user re-uploads).
