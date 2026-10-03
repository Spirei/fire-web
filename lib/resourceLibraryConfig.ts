export const RESOURCE_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const RESOURCE_QUOTA = 1024 * 1024 * 1024;
export const RESOURCE_CATEGORIES = ["components", "media"] as const;
export const RESOURCE_KINDS = ["image", "video", "audio", "document", "archive", "other"] as const;
export type ResourceCategory = typeof RESOURCE_CATEGORIES[number];
export type ResourceKind = typeof RESOURCE_KINDS[number];
export const RESOURCE_EXTENSIONS = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"],
  video: ["mp4", "mov", "webm"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "flac"],
  document: ["pdf", "txt", "md", "csv", "json", "docx", "xlsx", "pptx"],
  archive: ["zip", "gz", "7z", "rar"]
} as const;
export function resourceLibraryDiscovery(version: 1 | 2) {
  const base = `/api/v${version}/resource-library`;
  return {
    supported: true, contract_version: 1, path: base, received_files_path: `${base}/files`,
    read_scope: "resources.read", write_scope: "resources.write",
    categories: [{ id: "components", name: "构建" }, { id: "media", name: "影音内容" }],
    file_kinds: RESOURCE_KINDS, recognized_extensions: RESOURCE_EXTENSIONS,
    file_sorts: ["name", "createdAt"], sort_directions: ["asc", "desc"],
    max_upload_bytes: RESOURCE_UPLOAD_LIMIT, quota_bytes: RESOURCE_QUOTA,
    page_size: 30, max_page_size: 100, max_folders: 128, max_folder_depth: 8, max_files: 5000,
    upload_format: "multipart/form-data", upload_name_field: "name", download_auth: "bearer", range_supported: true,
    automatic_mutation_replay: false
  };
}
