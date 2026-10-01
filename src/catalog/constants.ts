export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif"
]);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".mpg",
  ".mpeg",
  ".mts",
  ".m2ts",
  ".3gp",
  ".wmv"
]);

export const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS
]);

export const IGNORED_DIRECTORY_NAMES = new Set([
  "$recycle.bin",
  "system volume information"
]);
