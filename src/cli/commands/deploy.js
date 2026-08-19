import { deploy } from '../../lib/deploy.js';
import { CliError } from '../../errors.js';

function parseDeployArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir') options.dir = args[i + 1];
    if (args[i] === '--slug') options.slug = args[i + 1];
  }
  return options;
}

export async function deployCommand(args, { json } = {}) {
  const { dir, slug } = parseDeployArgs(args);
  if (!dir || !slug) {
    throw new CliError('deploy requires both --dir <path> and --slug <slug>', 'MISSING_ARGUMENT');
  }
  const result = await deploy({ dir, slug });
  return { status: result.status, url: result.url, slug: result.slug };
}
