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

const MAX_LISTINGS_PER_RUN = 5; // Process only 5 listings then exit to clear memory

async function main() {
  console.log("Starting migration batch...");

  // Log initial memory
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Initial Memory Usage: ${Math.round(used * 100) / 100} MB`);

  // Get total count for progress
  const totalListings = await prisma.listing.count();
  console.log(`Found ${totalListings} listings.`);

  let processedCount = 0;
  const batchSize = 1; // Fetch one by one to keep memory low
  let cursorId: number | undefined;
  let listingsProcessedInRun = 0;

  while (true) {
    if (listingsProcessedInRun >= MAX_LISTINGS_PER_RUN) {
      console.log(
        `Reached limit of ${MAX_LISTINGS_PER_RUN} listings. Exiting for restart.`,
      );
      break;
    }

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
      listingsProcessedInRun++;

      console.log(
        `Processing listing ${listing.id} (${processedCount}/${totalListings})`,
      );

      let migratedCount = 0;
      let failedCount = 0;
      // Initialize newPhotos with existing photos to maintain order
      const newPhotos: string[] = [...listing.photos];

      const totalPhotos = listing.photos.length;
      if (totalPhotos > 0) {
        console.log(
          `  Found ${totalPhotos} photos. Checking for migration needs...`,
        );
      }

      for (const [index, photo] of listing.photos.entries()) {
        // Resume check: if it starts with https, assume it's already migrated or valid
        if (photo.startsWith("https://")) {
          continue;
        }

        console.log(`  Migrating photo ${index + 1}/${totalPhotos}: ${photo}`);

        try {
          // It's a public ID. Construct Cloudinary URL to download.
          const downloadUrl = cloudinary.url(photo, { secure: true });

          const stream = await getDownloadStream(downloadUrl);

          const key = photo.replace(/^jayeman\//, "");

          // Race the upload against a 60s timeout
          const uploadPromise = uploadStream({ stream, key });
          const timeoutPromise = new Promise<string>((_, reject) =>
            setTimeout(
              () => reject(new Error("Upload timed out after 60s")),
              60000,
            ),
          );

          const newUrl = await Promise.race([uploadPromise, timeoutPromise]);

          // Update the specific photo in our local array
          newPhotos[index] = newUrl;
          migratedCount++;
          console.log(`  ✅ Success: ${newUrl}`);

          // INCREMENTAL SAVE: Update DB immediately after each success
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

        // Log memory after each photo
        const currentMem = process.memoryUsage().heapUsed / 1024 / 1024;
        if (currentMem > 500) {
          // Warn if heap > 500MB
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
        console.log(
          `  ⚠️ Finished listing with errors. Failed: ${failedCount}`,
        );
      }
    }
  }

  console.log("Batch complete.");
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
