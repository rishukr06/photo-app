import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  bucketName: string;
  endpoint?: string;
  prefix?: string;
}

export interface S3MediaItem {
  key: string;
  name: string;
  size: number;
  lastModified?: Date;
  presignedUrl?: string;
  type: "image" | "video" | "other";
  // Enriched from metadata index after load
  dateTaken?: string; // ISO — from x-amz-meta-date-taken
  gpsLat?: string;
  gpsLng?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  area?: string;    // neighbourhood / suburb
  street?: string;  // road name
}

// Global cached client instance
let s3ClientInstance: S3Client | null = null;
let currentCredsHash = "";

// Generate a simple hash to check if credentials changed
const getCredsHash = (creds: S3Credentials): string => {
  return `${creds.accessKeyId}::${creds.region}::${creds.bucketName}::${creds.endpoint || ""}`;
};

/**
 * Gets or creates the S3Client instance.
 */
export const getS3Client = (creds: S3Credentials): S3Client => {
  const hash = getCredsHash(creds);
  if (s3ClientInstance && currentCredsHash === hash) {
    return s3ClientInstance;
  }

  const clientConfig: any = {
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  };

  if (creds.endpoint) {
    clientConfig.endpoint = creds.endpoint;
    // For local testing (like MinIO) or custom endpoints, force path style access
    clientConfig.forcePathStyle = true;
  }

  s3ClientInstance = new S3Client(clientConfig);
  currentCredsHash = hash;
  return s3ClientInstance;
};

/**
 * Tests connection to the bucket by listing 1 object.
 */
export const testS3Connection = async (creds: S3Credentials): Promise<boolean> => {
  const client = getS3Client(creds);
  const command = new ListObjectsV2Command({
    Bucket: creds.bucketName,
    MaxKeys: 1,
    Prefix: creds.prefix || undefined,
  });

  await client.send(command);
  return true;
};

/**
 * Guesses media type from key name
 */
export const getMediaType = (key: string): "image" | "video" | "other" => {
  const ext = key.split(".").pop()?.toLowerCase();
  if (!ext) return "other";
  
  const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "svg", "bmp"];
  const videoExts = ["mp4", "webm", "ogg", "mov", "avi", "mkv", "3gp"];
  
  if (imageExts.includes(ext)) return "image";
  if (videoExts.includes(ext)) return "video";
  return "other";
};

/**
 * Lists all objects in the bucket (optional recursive/paginated)
 */
export const listS3Objects = async (creds: S3Credentials): Promise<S3MediaItem[]> => {
  const client = getS3Client(creds);
  let isTruncated = true;
  let nextContinuationToken: string | undefined = undefined;
  const items: S3MediaItem[] = [];

  while (isTruncated) {
    const listCmd = new ListObjectsV2Command({
      Bucket: creds.bucketName,
      Prefix: creds.prefix || undefined,
      ContinuationToken: nextContinuationToken,
    });

    const response = (await client.send(listCmd)) as any;
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (!obj.Key) continue;
        
        // Skip directory markers and internal app files
        if (obj.Key.endsWith("/")) continue;
        if (obj.Key.endsWith("s3store-meta.json"))    continue;
        if (obj.Key.endsWith("s3store-meta.parquet")) continue;

        const name = obj.Key.substring((creds.prefix || "").length);

        items.push({
          key: obj.Key,
          name: name,
          size: obj.Size || 0,
          lastModified: obj.LastModified,
          type: getMediaType(obj.Key),
        });
      }
    }

    isTruncated = response.IsTruncated || false;
    nextContinuationToken = response.NextContinuationToken;
  }

  // Sort by last modified date (newest first)
  return items.sort((a, b) => {
    const dateA = a.lastModified ? a.lastModified.getTime() : 0;
    const dateB = b.lastModified ? b.lastModified.getTime() : 0;
    return dateB - dateA;
  });
};

/**
 * Generates a temporary presigned URL for reading an object.
 */
export const getPresignedReadUrl = async (
  creds: S3Credentials, 
  key: string, 
  expiresInSeconds = 3600
): Promise<string> => {
  const client = getS3Client(creds);
  const command = new GetObjectCommand({
    Bucket: creds.bucketName,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

/**
 * Uploads a file with progress tracking by generating a presigned PUT URL
 * and performing a native XMLHttpRequest PUT.
 * Pass `metadata` (Record<string, string>) to store EXIF/file info as S3 object
 * metadata (exposed as x-amz-meta-* headers). The same keys are signed into the
 * presigned URL, so they MUST be sent in the XHR headers too.
 */
export const uploadS3FileWithProgress = async (
  creds: S3Credentials,
  file: File,
  destKey: string,
  onProgress: (percent: number) => void,
  metadata?: Record<string, string>
): Promise<string> => {
  const client = getS3Client(creds);

  // Step 1: clean presigned PUT — no metadata in the signature so there is
  // no risk of a CORS preflight blocking x-amz-meta-* headers or a
  // signature mismatch between the signed URL and the XHR request.
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: creds.bucketName, Key: destKey, ContentType: file.type }),
    { expiresIn: 3600 }
  );

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      xhr.status === 200 || xhr.status === 204
        ? resolve()
        : reject(new Error(`Upload failed with status ${xhr.status}`));
    });
    xhr.addEventListener("error", () =>
      reject(new Error("Network error during upload. Check CORS on your S3 bucket."))
    );
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted.")));

    xhr.send(file);
  });

  // Step 2: attach EXIF/file metadata via a server-side copy-to-self.
  // CopyObject replaces only the metadata — no data is transferred.
  // Wrapped in try/catch so a CORS or permission failure on this step
  // doesn't roll back the (already successful) upload.
  if (metadata && Object.keys(metadata).length > 0) {
    try {
      await client.send(new CopyObjectCommand({
        Bucket: creds.bucketName,
        CopySource: `${creds.bucketName}/${destKey}`,
        Key: destKey,
        ContentType: file.type,
        Metadata: metadata,
        MetadataDirective: "REPLACE",
      }));
    } catch (e) {
      console.warn("Metadata attachment failed (file upload succeeded):", e);
    }
  }

  return destKey;
};

/**
 * Fetches the x-amz-meta-* metadata stored on an S3 object (HeadObject).
 * Keys are returned without the x-amz-meta- prefix, e.g. "date-taken".
 */
export const getObjectMetadata = async (
  creds: S3Credentials,
  key: string
): Promise<Record<string, string>> => {
  const client = getS3Client(creds);
  const response = await client.send(new HeadObjectCommand({
    Bucket: creds.bucketName,
    Key: key,
  }));
  const meta = response.Metadata ?? {};
  console.debug("[s3store] HeadObject metadata for", key, meta);
  return meta;
};

/** The CORS rule S3Store needs to function correctly. */
export const REQUIRED_CORS_RULE = {
  AllowedHeaders: ["*"],
  AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
  AllowedOrigins: ["*"],
  // S3 does not support wildcards in ExposeHeaders — list each header explicitly.
  ExposeHeaders: [
    "ETag",
    "x-amz-meta-original-name",
    "x-amz-meta-file-date",
    "x-amz-meta-date-taken",
    "x-amz-meta-gps-lat",
    "x-amz-meta-gps-lng",
    "x-amz-meta-gps-altitude",
    "x-amz-meta-camera-make",
    "x-amz-meta-camera-model",
  ],
  MaxAgeSeconds: 3000,
};

/**
 * Reads the current CORS config and checks whether x-amz-meta-* is exposed.
 * Returns true when the config is already correct.
 */
export const checkCorsSufficient = async (creds: S3Credentials): Promise<boolean> => {
  const client = getS3Client(creds);
  try {
    const response = await client.send(new GetBucketCorsCommand({ Bucket: creds.bucketName }));
    return (response.CORSRules ?? []).some(rule =>
      (rule.ExposeHeaders ?? []).includes("x-amz-meta-date-taken")
    );
  } catch {
    return false;
  }
};

/**
 * Applies REQUIRED_CORS_RULE to the bucket, replacing the first existing rule.
 * Preserves any additional rules the user may have added.
 */
export const applyRequiredCors = async (creds: S3Credentials): Promise<void> => {
  const client = getS3Client(creds);

  // Read existing rules so we don't wipe custom ones
  let existingRules: any[] = [];
  try {
    const get = await client.send(new GetBucketCorsCommand({ Bucket: creds.bucketName }));
    existingRules = get.CORSRules ?? [];
  } catch {
    // No CORS config yet — start fresh
  }

  // Replace the first rule that has AllowedOrigins ["*"] (our rule), keep the rest
  const ourRuleIdx = existingRules.findIndex(r =>
    (r.AllowedOrigins ?? []).includes("*")
  );
  const merged = [...existingRules];
  if (ourRuleIdx >= 0) {
    merged[ourRuleIdx] = REQUIRED_CORS_RULE;
  } else {
    merged.unshift(REQUIRED_CORS_RULE);
  }

  await client.send(new PutBucketCorsCommand({
    Bucket: creds.bucketName,
    CORSConfiguration: { CORSRules: merged },
  }));
};

/**
 * Deletes an object from the bucket.
 */
export const deleteS3Object = async (creds: S3Credentials, key: string): Promise<boolean> => {
  const client = getS3Client(creds);
  const command = new DeleteObjectCommand({
    Bucket: creds.bucketName,
    Key: key,
  });

  await client.send(command);
  return true;
};
