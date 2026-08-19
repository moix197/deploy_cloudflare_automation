import { listProjects } from '../../lib/listProjects.js';

const COLUMNS = [
  { header: 'NAME', get: (project) => project.name },
  { header: 'SUBDOMAIN', get: (project) => project.subdomain },
  { header: 'PRODUCTION BRANCH', get: (project) => project.productionBranch },
];

function formatRow(cells, columnWidths) {
  return cells.map((cell, i) => cell.padEnd(columnWidths[i])).join('  ').trimEnd();
}

function formatProjectsTable(projects) {
  const columnWidths = COLUMNS.map((column) =>
    Math.max(column.header.length, ...projects.map((project) => String(column.get(project) ?? '').length)),
  );
  const rows = [
    formatRow(COLUMNS.map((column) => column.header), columnWidths),
    ...projects.map((project) => formatRow(COLUMNS.map((column) => String(column.get(project) ?? '')), columnWidths)),
  ];
  return rows.join('\n');
}

/**
 * `cli.js`'s generic `printResult` just prints `key: value` per return
 * entry, which renders an array of project objects as `[object Object]` —
 * not usable output. So for the human path this command prints its own
 * table directly and returns `{}` (nothing left for `printResult` to add);
 * `--json` keeps returning `{projects, count}` so `printResult` emits the
 * documented JSON shape unchanged. `json` is the same flag `cli.js` already
 * computed from argv — read from the options bag it passes as the second
 * argument, not re-parsed from `args` here.
 */
export async function listCommand(args = [], { json = false } = {}) {
  const projects = await listProjects();

  if (!json) {
    console.log(projects.length === 0 ? 'No projects found.' : formatProjectsTable(projects));
    return {};
  }

  return { projects, count: projects.length };
}
