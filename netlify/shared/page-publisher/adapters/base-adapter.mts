// Adapter interface — page-publisher-build-spec.md §1. GIT_STATIC is the
// reference implementation (git-static-adapter.mts); WordPress/Wix/Manual
// slot into the SAME interface later without a refactor (Stage 5/6). An
// adapter that can't do something returns { supported: false, reason },
// never throws.

export type Platform = "git_static" | "wordpress" | "wix" | "manual";

export interface CapabilityFlags {
  canCreatePage: boolean;
  canCreatePost: boolean;
  canListExistingUrls: boolean;
  canEditExistingPage: boolean;
  canSetCanonical: boolean;
  canSetMetaDescription: boolean;
  canInjectSchema: boolean;
  canUploadMedia: boolean;
  autoPublish: boolean;
}

export interface Credentials {
  // GIT_STATIC uses the existing GITHUB_TOKEN env var — nothing per-site to
  // store here yet (§0's non-negotiable constraint: no new credential
  // storage needed for this tier). Present for the interface's sake so
  // WordPress/Wix (real per-site tokens) slot in later without a shape change.
  [key: string]: any;
}

export interface Site {
  id: string;
  clientId: string;
  domain: string;
  repo?: string;
  branch?: string;
  pagesDir?: string;
}

export interface ExistingUrl {
  url: string;
  title: string;
  path: string;
  parentUrl: string | null;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export interface PublishResult {
  ok: boolean;
  publishedUrl?: string;
  commitSha?: string;
  platformRef?: string;
  detail: string;
}

export interface LinkResult {
  ok: boolean;
  detail: string;
}

// Minimal shapes — the adapter only needs enough of Page/PageImage/
// InboundLinkTask to do its job; the real, full shapes live in
// shared/page-publisher/firestore.mts (PagePublisherPage etc.) and callers
// pass those straight through.
export interface AdapterPage {
  id: string;
  slug: string;
  htmlBody: string;
  [key: string]: any;
}
export interface AdapterImage {
  storedPath: string;
  originalFilename: string;
  [key: string]: any;
}
export interface InboundLinkTask {
  sourceUrl: string;
  anchorText: string;
  targetUrl: string;
}

export type SupportResult<T> = T | { supported: false; reason: string };

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: CapabilityFlags;

  verifyConnection(creds: Credentials, site: Site): Promise<VerifyResult>;
  listExistingUrls(creds: Credentials, site: Site): Promise<SupportResult<ExistingUrl[]>>;
  fetchPageHtml(creds: Credentials, site: Site, url: string): Promise<SupportResult<string>>;
  uploadImage(creds: Credentials, site: Site, image: AdapterImage): Promise<SupportResult<{ remoteUrl: string }>>;
  publish(creds: Credentials, site: Site, page: AdapterPage): Promise<SupportResult<PublishResult>>;
  update(creds: Credentials, site: Site, page: AdapterPage, platformRef: string): Promise<SupportResult<PublishResult>>;
  insertInboundLink(creds: Credentials, site: Site, task: InboundLinkTask): Promise<SupportResult<LinkResult>>;
}

export function isUnsupported<T>(r: SupportResult<T>): r is { supported: false; reason: string } {
  return typeof r === "object" && r !== null && (r as any).supported === false;
}
