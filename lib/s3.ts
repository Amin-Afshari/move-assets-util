import { Upload } from "@aws-sdk/lib-storage";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

function getRequiredEnv(key: string) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key}`);
  }
  return value;
}

export const client = new S3Client({
  region: "default",
  endpoint: getRequiredEnv("ARVAN_ENDPOINT").startsWith("http")
    ? getRequiredEnv("ARVAN_ENDPOINT")
    : `https://${getRequiredEnv("ARVAN_ENDPOINT")}`,
  credentials: {
    accessKeyId: getRequiredEnv("ARVAN_ACCESS_KEY"),
    secretAccessKey: getRequiredEnv("ARVAN_SECRET_KEY"),
  },
});

export function getFileUrl(key: string): string {
  const endpoint = getRequiredEnv("ARVAN_ENDPOINT");
  // Check if we should use ARVAN_BUCKET or ARVAN_BUCKET_NAME
  // The current file seems to use ARVAN_BUCKET, so we stick to it.
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;

  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");

  // Clean endpoint: remove https://
  const endpointClean = endpoint.replace(/^https?:\/\//, "");
  return `https://${bucket}.${endpointClean}/${key}`;
}

export async function uploadImage({ file, key }: { file: File; key: string }) {
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;
  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: file.type || "application/octet-stream",
      ACL: "public-read",
    }),
  );
}

export async function uploadBuffer({
  buffer,
  key,
  contentType = "image/jpeg",
}: {
  buffer: Buffer;
  key: string;
  contentType?: string;
}) {
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;
  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
    }),
  );

  return getFileUrl(key);
}

export async function uploadStream({
  stream,
  key,
  contentType = "image/jpeg",
}: {
  stream: Readable | ReadableStream;
  key: string;
  contentType?: string;
}) {
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;
  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
      ACL: "public-read",
    },
  });

  await upload.done();

  return getFileUrl(key);
}

export async function deleteImage(key: string) {
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;
  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}
