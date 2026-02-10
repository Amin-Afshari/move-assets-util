import { v2 as cloudinary } from "cloudinary";
import { uploadStream } from "../lib/s3";
import https from "https";
import { prisma } from "@/lib/prisma";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function getArvanPrefix(): string {
  const endpoint = process.env.ARVAN_ENDPOINT;
  const bucket = process.env.ARVAN_BUCKET || process.env.ARVAN_BUCKET_NAME;
  if (!endpoint) throw new Error("Missing ARVAN_ENDPOINT");
  if (!bucket) throw new Error("Missing ARVAN_BUCKET or ARVAN_BUCKET_NAME");
  const endpointClean = endpoint.replace(/^https?:\/\//, "");
  return `https://${bucket}.${endpointClean}/`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function getObjectKeyFromCloudinaryUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const uploadIndex = segments.findIndex((s) => s === "upload");
    if (uploadIndex === -1) return null;
    const afterUpload = segments.slice(uploadIndex + 1);
    const versionIndex = afterUpload.findIndex((s) => /^v\d+$/.test(s));
    const publicIdSegments =
      versionIndex >= 0 ? afterUpload.slice(versionIndex + 1) : afterUpload;
    const publicId = publicIdSegments.join("/");
    if (!publicId) return null;
    return publicId.replace(/^jayeman\//, "");
  } catch {
    return null;
  }
}

function getDownloadStream(url: string): Promise<Readable> {
  console.log(`    -> Starting download stream: ${url}`);
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(
          new Error(
            `Failed to download: ${res.statusCode} ${res.statusMessage}`,
          ),
        );
        return;
      }
      resolve(res);
    });

    req.on("error", (err) => {
      console.error(`    -> Request error: ${err.message}`);
      reject(err);
    });

    req.setTimeout(30000, () => {
      console.error(`    -> Request timed out: ${url}`);
      req.destroy(new Error("Request timed out"));
    });
  });
}

process.on("uncaughtException", (err) => {
  console.error("CRITICAL: Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "CRITICAL: Unhandled Rejection at:",
    promise,
    "reason:",
    reason,
  );
});

const MAX_LISTINGS_PER_RUN = 5;

async function main() {
  console.log("Starting migration batch...");
  const arvanPrefix = getArvanPrefix();
  const arvanLike = `${arvanPrefix}%`;

  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Initial Memory Usage: ${Math.round(used * 100) / 100} MB`);

  const candidates = await prisma.$queryRaw<
    Array<{ id: number; photos: string[] }>
  >`
    SELECT id, photos
    FROM listings
    WHERE EXISTS (
      SELECT 1
      FROM unnest(photos) AS p
      WHERE p NOT LIKE ${arvanLike}
    )
    ORDER BY id ASC
    LIMIT ${MAX_LISTINGS_PER_RUN}
  `;

  if (candidates.length === 0) {
    console.log(
      "No listings with unmigrated photos found. Migration complete.",
    );
    return;
  }

  console.log(`Found ${candidates.length} candidate listings in this batch.`);

  for (const [listingIndex, listing] of candidates.entries()) {
    console.log(
      `Processing listing ${listing.id} (${listingIndex + 1}/${candidates.length})`,
    );

    let migratedCount = 0;
    let failedCount = 0;
    const newPhotos: string[] = [...listing.photos];

    const totalPhotos = listing.photos.length;
    if (totalPhotos > 0) {
      console.log(
        `  Found ${totalPhotos} photos. Checking for migration needs...`,
      );
    }

    for (const [index, photo] of listing.photos.entries()) {
      if (isHttpUrl(photo) && photo.startsWith(arvanPrefix)) {
        console.log(
          `  Skipping photo ${index + 1}/${totalPhotos}: already Arvan`,
        );
        continue;
      }

      console.log(`  Migrating photo ${index + 1}/${totalPhotos}: ${photo}`);

      try {
        const downloadUrl = isHttpUrl(photo)
          ? photo
          : cloudinary.url(photo, { secure: true });

        const stream = await getDownloadStream(downloadUrl);

        const key = isHttpUrl(photo)
          ? (getObjectKeyFromCloudinaryUrl(photo) ??
            new URL(photo).pathname
              .replace(/^\/+/, "")
              .replace(/^jayeman\//, ""))
          : photo.replace(/^jayeman\//, "");

        const uploadPromise = uploadStream({ stream, key });
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error("Upload timed out after 60s")),
            60000,
          ),
        );

        const newUrl = await Promise.race([uploadPromise, timeoutPromise]);

        newPhotos[index] = newUrl;
        migratedCount++;
        console.log(`  ✅ Success: ${newUrl}`);

        await prisma.listing.update({
          where: { id: listing.id },
          data: { photos: newPhotos },
        });
      } catch (error) {
        console.error(
          `  ❌ Failed to migrate photo ${photo}:`,
          error instanceof Error ? error.message : error,
        );
        failedCount++;
      }

      const currentMem = process.memoryUsage().heapUsed / 1024 / 1024;
      if (currentMem > 500) {
        console.warn(
          `  ⚠️ High Memory Usage: ${Math.round(currentMem * 100) / 100} MB`,
        );
        if (global.gc) {
          console.log("  Running Garbage Collection...");
          global.gc();
        }
      }
    }

    if (migratedCount === 0 && failedCount === 0 && totalPhotos > 0) {
      console.log(`  No changes needed. All photos were already migrated.`);
    } else if (failedCount > 0) {
      console.log(`  ⚠️ Finished listing with errors. Failed: ${failedCount}`);
    }
  }

  console.log("Batch complete.");
}

if (import.meta.main) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
