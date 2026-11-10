export { deploy } from './lib/deploy.js';
export { listProjects } from './lib/listProjects.js';
export { deleteProject } from './lib/deleteProject.js';
export { deploySharded, removeSharded, initShards } from './lib/sharded/shardedDeploy.js';

// Public error classes, so a library consumer can branch on `error.code` /
// `instanceof` without reaching into `src/errors.js` internals.
export * from './errors.js';
