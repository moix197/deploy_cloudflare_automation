// A Pages manifest maps `/<path>` to an asset hash. A shard's manifest holds
// every demo it hosts, each under its own `/<slug>/` prefix.

export function slugPrefix(slug) {
  return `/${slug}/`;
}

export function toSlugManifest(slug, assets) {
  return Object.fromEntries(assets.map((asset) => [`${slugPrefix(slug)}${asset.name}`, asset.hash]));
}

export function withoutSlug(manifest, slug) {
  const prefix = slugPrefix(slug);
  return Object.fromEntries(Object.entries(manifest).filter(([path]) => !path.startsWith(prefix)));
}

/**
 * The shard's next manifest: the stored one with every `/<slug>/…` entry
 * replaced by `slugManifest`, so files the new build dropped disappear.
 */
export function mergeSlugManifest(stored, slug, slugManifest) {
  return { ...withoutSlug(stored, slug), ...slugManifest };
}
