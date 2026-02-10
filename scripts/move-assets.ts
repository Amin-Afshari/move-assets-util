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

// Global error handlers to prevent silent exits
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
  // Do not exit here to see if the loop can recover, or exit if preferred
});

async function main() {
  console.log("Starting migration...");

  // Get total count for progress
  const totalListings = await prisma.listing.count();
  console.log(`Found ${totalListings} listings.`);

  let processedCount = 0;
  const batchSize = 10;
  let cursorId: number | undefined;

  while (true) {
    const listings = await prisma.listing.findMany({
      take: batchSize,
      skip: cursorId ? 1 : 0,
      cursor: cursorId ? { id: cursorId } : undefined,
      orderBy: { id: "asc" },
    });

    if (listings.length === 0) break;

    for (const listing of listings) {
      cursorId = listing.id;
      processedCount++;

      console.log(
        `Processing listing ${listing.id} (${processedCount}/${totalListings})`,
      );

      let hasChanges = false;
      let migratedCount = 0;
      let failedCount = 0;
      const newPhotos: string[] = [];

      const totalPhotos = listing.photos.length;
      if (totalPhotos > 0) {
        console.log(
          `  Found ${totalPhotos} photos. Checking for migration needs...`,
        );
      }

      for (const [index, photo] of listing.photos.entries()) {
        // Resume check: if it starts with https, assume it's already migrated or valid
        if (photo.startsWith("https://")) {
          // console.log(`  Skipping photo ${index + 1}/${totalPhotos}: Already migrated.`);
          newPhotos.push(photo);
          continue;
        }

        console.log(`  Migrating photo ${index + 1}/${totalPhotos}: ${photo}`);

        try {
          // It's a public ID. Construct Cloudinary URL to download.
          const downloadUrl = cloudinary.url(photo, { secure: true });

          // console.log(`  Downloading...`);
          const stream = await getDownloadStream(downloadUrl);

          // Use the photo path (public ID) but strip the 'jayeman/' prefix since the bucket is already named jayeman
          // e.g. "jayeman/listings/1/file_sdyogz" -> "listings/1/file_sdyogz"
          const key = photo.replace(/^jayeman\//, "");

          // console.log(`  Uploading...`);
          const newUrl = await uploadStream({ stream, key });

          newPhotos.push(newUrl);
          hasChanges = true;
          migratedCount++;
          console.log(`  ✅ Success: ${newUrl}`);
        } catch (error) {
          console.error(
            `  ❌ Failed to migrate photo ${photo}:`,
            error instanceof Error ? error.message : error,
          );
          // Keep the old one if failed, so we can retry later (since it won't be https)
          newPhotos.push(photo);
          failedCount++;
        }
      }

      if (hasChanges) {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { photos: newPhotos },
        });
        console.log(
          `  💾 Saved changes to DB. Migrated: ${migratedCount}, Failed: ${failedCount}`,
        );
      } else if (migratedCount === 0 && failedCount === 0 && totalPhotos > 0) {
        console.log(`  No changes needed. All photos were already migrated.`);
      } else if (failedCount > 0) {
        console.log(`  ⚠️ Finished with errors. Failed: ${failedCount}`);
      }
    }
  }

  console.log("Migration complete.");
}

// Only run if this file is the main entry point
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
