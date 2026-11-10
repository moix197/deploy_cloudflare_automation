import { initShards } from '../../lib/sharded/shardedDeploy.js';
import { CliError } from '../../errors.js';

export async function shardsCommand(args) {
  const [subcommand] = args;
  if (subcommand !== 'init') {
    throw new CliError('usage: shards init', 'UNKNOWN_COMMAND');
  }
  return initShards();
}
