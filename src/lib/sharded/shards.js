export const SHARD_COUNT = 10;
export const SHARD_PREFIX = 'wx-demos-';

// Pages caps a deployment at 20,000 files; new placements stop at 18,000 so
// existing demos on a shard still have room to grow when redeployed.
export const PAGES_FILE_LIMIT = 20_000;
export const SHARD_FILE_BUDGET = 18_000;

export function shardNames(count = SHARD_COUNT) {
  return Array.from({ length: count }, (_, i) => `${SHARD_PREFIX}${String(i + 1).padStart(2, '0')}`);
}

/**
 * An existing placement always wins (a demo never moves). Otherwise the
 * shard with the fewest files that stays within `budget` after adding
 * `fileCount`; ties go to the lowest-numbered shard. `null` = every shard is full.
 * `loads` maps shard name → files currently placed there.
 */
export function chooseShard({ placement, loads, fileCount, shards = shardNames(), budget = SHARD_FILE_BUDGET }) {
  if (placement) return placement.shard;
  let best = null;
  for (const name of shards) {
    const files = loads[name] ?? 0;
    if (files + fileCount > budget) continue;
    if (!best || files < best.files) best = { name, files };
  }
  return best?.name ?? null;
}
