import exifr from "exifr";

// S3 metadata key → stored as x-amz-meta-{key}
export interface FileS3Metadata {
  "original-name": string;
  "file-date": string;          // file.lastModified ISO
  "date-taken"?: string;        // EXIF DateTimeOriginal ISO
  "gps-lat"?: string;
  "gps-lng"?: string;
  "gps-altitude"?: string;
  "camera-make"?: string;
  "camera-model"?: string;
}

const EXIF_SUPPORTED = /\.(jpe?g|heic|heif|tiff?|webp|png|avif)$/i;

/** Extract all available metadata from a File. Never throws. */
export async function extractMetadata(file: File): Promise<FileS3Metadata> {
  const meta: FileS3Metadata = {
    "original-name": sanitize(file.name),
    "file-date": new Date(file.lastModified).toISOString(),
  };

  if (!EXIF_SUPPORTED.test(file.name)) return meta;

  try {
    const exif = await exifr.parse(file, {
      gps: true,
      pick: [
        "DateTimeOriginal", "CreateDate",
        "Make", "Model",
        "GPSLatitude", "GPSLongitude", "GPSAltitude",
      ],
    });

    if (!exif) return meta;

    const dateTaken = exif.DateTimeOriginal ?? exif.CreateDate;
    if (dateTaken instanceof Date && !isNaN(dateTaken.getTime())) {
      meta["date-taken"] = dateTaken.toISOString();
    }

    if (typeof exif.latitude === "number") {
      meta["gps-lat"] = exif.latitude.toFixed(7);
    }
    if (typeof exif.longitude === "number") {
      meta["gps-lng"] = exif.longitude.toFixed(7);
    }
    if (typeof exif.GPSAltitude === "number") {
      meta["gps-altitude"] = exif.GPSAltitude.toFixed(1);
    }
    if (exif.Make)  meta["camera-make"]  = sanitize(String(exif.Make));
    if (exif.Model) meta["camera-model"] = sanitize(String(exif.Model));
  } catch {
    // Not parseable — return what we have
  }

  return meta;
}

/** Strip non-ASCII characters and cap length — S3 metadata must be ASCII, max 2 KB total. */
function sanitize(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "").trim().substring(0, 256);
}
