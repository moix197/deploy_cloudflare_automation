import { deleteProject } from '../../lib/deleteProject.js';
import { CliError } from '../../errors.js';

function parseDeleteArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--slug') options.slug = args[i + 1];
  }
  return options;
}

export async function deleteCommand(args, { json } = {}) {
  const { slug } = parseDeleteArgs(args);
  if (!slug) {
    throw new CliError('delete requires --slug <slug>', 'MISSING_ARGUMENT');
  }
  return deleteProject({ slug });
}
