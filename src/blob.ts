/**
 * Our own HMAC-signed URLs: R2 bindings expose no presigned URLs, so the
 * Worker mints time-boxed signed paths on our domain (15-min, §6 keeps the
 * 10 MB tier unusable as a discount CDN).
 *
 *   GET /v1/blob/{r2key}?exp=&sig=          sig = HMAC("blob:{key}:{exp}")
 *   PUT /v1/upload/{r2key}?exp=&size=&sig=  sig = HMAC("upload:{key}:{size}:{exp}")
 */

import { hmacHex } from "./auth.ts";
import { err, LIMITS } from "./codes.ts";
import type { Env } from "./types.ts";
import { nowS } from "./types.ts";

/** Constant-time hex-string equality — no early-exit timing oracle on our MAC. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signedGetUrl(env: Env, r2key: string): Promise<string> {
  const exp = nowS() + LIMITS.signed_url_seconds;
  const sig = await hmacHex(env, `blob:${r2key}:${exp}`);
  return `${env.PUBLIC_BASE_URL}/v1/blob/${r2key}?exp=${exp}&sig=${sig}`;
}

export async function signedPutUrl(env: Env, r2key: string, size: number): Promise<string> {
  const exp = nowS() + LIMITS.signed_url_seconds;
  const sig = await hmacHex(env, `upload:${r2key}:${size}:${exp}`);
  return `${env.PUBLIC_BASE_URL}/v1/upload/${r2key}?exp=${exp}&size=${size}&sig=${sig}`;
}

export async function serveBlob(env: Env, r2key: string, exp: string | null, sig: string | null): Promise<Response> {
  if (!exp || !sig || Number(exp) < nowS()) return err("NOT_FOUND", "Link expired or invalid.", 404);
  if (!timingSafeEqual(await hmacHex(env, `blob:${r2key}:${exp}`), sig))
    return err("NOT_FOUND", "Link expired or invalid.", 404);
  const obj = await env.BODIES.get(r2key);
  if (!obj)
    return err("NOT_FOUND", "Body unavailable — retry shortly.", 503, { retry_after_seconds: 30 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function acceptUpload(
  env: Env,
  r2key: string,
  exp: string | null,
  size: string | null,
  sig: string | null,
  body: ReadableStream | null,
  declaredType: string | null,
): Promise<Response> {
  if (!exp || !sig || !size || Number(exp) < nowS())
    return err("NOT_FOUND", "Upload link expired or invalid.", 404);
  if (!timingSafeEqual(await hmacHex(env, `upload:${r2key}:${size}:${exp}`), sig))
    return err("NOT_FOUND", "Upload link expired or invalid.", 404);
  if (!body) return err("VALIDATION_ERROR", "Empty body.", 400);
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.byteLength !== Number(size))
    return err("VALIDATION_ERROR", `Body is ${bytes.byteLength} bytes; upload was authorized for ${size}.`, 400);
  await env.BODIES.put(r2key, bytes, {
    httpMetadata: declaredType ? { contentType: declaredType } : undefined,
  });
  return new Response(JSON.stringify({ stored: true, size: bytes.byteLength }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
