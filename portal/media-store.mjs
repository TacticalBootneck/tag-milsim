import { createHash, createHmac } from 'node:crypto';

const algorithm = 'AWS4-HMAC-SHA256';
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character =>
  '%' + character.charCodeAt(0).toString(16).toUpperCase());

export function createMediaStore(env, { now = Date.now, request = fetch } = {}) {
  const {
    TAG_MEDIA_ENDPOINT: endpoint, TAG_MEDIA_REGION: region, TAG_MEDIA_BUCKET: bucket,
    TAG_MEDIA_ACCESS_KEY_ID: accessKey, TAG_MEDIA_SECRET_ACCESS_KEY: secretKey,
  } = env;
  if (!accessKey && !secretKey) return null;
  const origin = URL.parse(endpoint ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.origin !== endpoint ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
      !/^[a-z0-9-]+$/.test(region ?? '') || !accessKey || !secretKey) {
    throw new Error('Check the five TAG_MEDIA settings in portal/.env.');
  }

  function signedUrl(method, key, expires) {
    const timestamp = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = timestamp.slice(0, 8);
    const scope = day + '/' + region + '/s3/aws4_request';
    const path = '/' + bucket + '/' + key.split('/').map(encode).join('/');
    const query = Object.entries({
      'X-Amz-Algorithm': algorithm,
      'X-Amz-Credential': accessKey + '/' + scope,
      'X-Amz-Date': timestamp,
      'X-Amz-Expires': expires,
      'X-Amz-SignedHeaders': 'host',
    }).map(([name, value]) => name + '=' + encode(value)).join('&');
    const canonical = [method, path, query, 'host:' + origin.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, [algorithm, timestamp, scope, hash(canonical)].join('\n')).toString('hex');
    return origin.origin + path + '?' + query + '&X-Amz-Signature=' + signature;
  }

  return {
    origin: origin.origin,
    imageUrl: key => signedUrl('GET', key, 300),
    async upload(key, bytes) {
      const result = await request(signedUrl('PUT', key, 60), {
        method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(15_000), body: bytes,
        headers: {'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store'},
      });
      await result.body?.cancel();
      if (!result.ok) throw new Error('IDrive e2 returned HTTP ' + result.status);
    },
  };
}
