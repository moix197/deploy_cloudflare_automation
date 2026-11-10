import { deploy } from '../../lib/deploy.js';
import { deploySharded } from '../../lib/sharded/shardedDeploy.js';
import { CliError } from '../../errors.js';

function parseDeployArgs(args) {
  const options = { sharded: args.includes('--sharded') };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir') options.dir = args[i + 1];
    if (args[i] === '--slug') options.slug = args[i + 1];
    if (args[i] === '--lead-id') options.leadId = Number(args[i + 1]);
    if (args[i] === '--d1-database') options.databaseId = args[i + 1];
  }
  return options;
}

async function deployShardedCommand({ dir, slug, leadId, databaseId }) {
  const result = await deploySharded({ dir, slug, leadId: Number.isInteger(leadId) ? leadId : null, databaseId });
  return { status: result.status, url: result.url, slug: result.slug, shard: result.shard, files: result.files, uploaded: result.uploaded, lock: result.lock };
}

export async function deployCommand(args, { json } = {}) {
  const options = parseDeployArgs(args);
  if (!options.dir || !options.slug) {
    throw new CliError('deploy requires both --dir <path> and --slug <slug>', 'MISSING_ARGUMENT');
  }
  if (options.sharded) return deployShardedCommand(options);
  const result = await deploy({ dir: options.dir, slug: options.slug });
  return { status: result.status, url: result.url, slug: result.slug };
}
