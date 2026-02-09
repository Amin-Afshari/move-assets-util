import { v2 as cloudinary } from "cloudinary";
import { downloadFile } from "./move-assets";
import { uploadBuffer } from "../lib/s3";
import dotenv from "dotenv";
import { prisma } from "@/lib/prisma";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function testMigration() {
  console.log("Starting TEST migration (1-2 assets)...");

  // Fetch some listings to find candidates
  const listings = await prisma.listing.findMany({
    take: 100,
    orderBy: { id: "desc" }, // Start from newest? or oldest? desc might have newer un-migrated ones?
    // actually older ones are more likely to be on cloudinary if we just switched.
    // Let's try asc.
  });

  let migratedCount = 0;
  const MAX_MIGRATION = 2;

  for (const listing of listings) {
    if (migratedCount >= MAX_MIGRATION) break;

    // Find a photo that is NOT https (needs migration)
    const needsMigrationIndex = listing.photos.findIndex(
      (p) => !p.startsWith("https://"),
    );

    if (needsMigrationIndex === -1) continue;

    const photo = listing.photos[needsMigrationIndex];
    console.log(`Found candidate: Listing ${listing.id}, Photo: ${photo}`);

    try {
      // 1. Download
      // Note: We use the same logic as in move-assets, assuming photo is a public ID
      const downloadUrl = cloudinary.url(photo, { secure: true });
      console.log(`  Downloading from ${downloadUrl}...`);

      const buffer = await downloadFile(downloadUrl);

      // 2. Upload
      // Use the photo path (public ID) but strip the 'jayeman/' prefix since the bucket is already named jayeman
      const key = photo.replace(/^jayeman\//, "");

      console.log(`  Uploading to Arvan: ${key}...`);
      const newUrl = await uploadBuffer({ buffer, key });
      console.log(`  Uploaded: ${newUrl}`);

      // 3. Update DB
      // Update only this specific photo in the array
      const newPhotos = [...listing.photos];
      newPhotos[needsMigrationIndex] = newUrl;

      await prisma.listing.update({
        where: { id: listing.id },
        data: { photos: newPhotos },
      });
      console.log(`  Updated Listing ${listing.id} photos in DB.`);

      // Verify
      const updatedListing = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      if (
        updatedListing &&
        updatedListing.photos[needsMigrationIndex] === newUrl
      ) {
        console.log("  ✅ SUCCESS: Database verification passed.");
      } else {
        console.error("  ❌ FAILURE: Database verification failed.");
      }

      migratedCount++;
    } catch (error) {
      console.error("  Test failed for this item:", error);
    }
  }

  if (migratedCount === 0) {
    console.log(
      "No candidates found for migration among the fetched listings.",
    );
  } else {
    console.log("Test migration finished.");
  }
}

testMigration()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
