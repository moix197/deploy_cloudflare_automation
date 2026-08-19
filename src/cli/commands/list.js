import { resolveAuth } from '../../auth/resolveAuth.js';
import { listProjects } from '../../lib/listProjects.js';

export async function listCommand() {
  const { apiToken, accountId } = resolveAuth();
  const projects = await listProjects({ apiToken, accountId });
  return { projects, count: projects.length };
}
