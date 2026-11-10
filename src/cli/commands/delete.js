import { deleteProject } from '../../lib/deleteProject.js';
import { removeSharded } from '../../lib/sharded/shardedDeploy.js';
import { CliError } from '../../errors.js';

function parseDeleteArgs(args) {
  const options = { sharded: args.includes('--sharded') };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--slug') options.slug = args[i + 1];
    if (args[i] === '--d1-database') options.databaseId = args[i + 1];
  }
  return options;
}

export async function deleteCommand(args, { json } = {}) {
  const { slug, sharded, databaseId } = parseDeleteArgs(args);
  if (!slug) {
    throw new CliError('delete requires --slug <slug>', 'MISSING_ARGUMENT');
  }
  if (sharded) return removeSharded({ slug, databaseId });
  return deleteProject({ slug });
}
