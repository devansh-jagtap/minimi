import { S3Client } from "@aws-sdk/client-s3";

let client: S3Client | undefined;

export function getDocumentBucket() {
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  if (!bucket) throw new Error("R2_BUCKET_NAME is not configured");
  return bucket;
}

export function getObjectStorageClient() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("Cloudflare R2 credentials are not configured");
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

export function getPresignedUrlTtlSeconds() {
  const configured = Number(process.env.R2_PRESIGN_TTL_SECONDS ?? 300);
  return Number.isInteger(configured) ? Math.min(Math.max(configured, 60), 600) : 300;
}
