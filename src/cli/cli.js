import { checkAuth } from './commands/checkAuth.js';
import { CliError } from '../errors.js';

const commands = {
  'check-auth': checkAuth,
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  return { command, json: rest.includes('--json') };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}: ${value}`);
  }
}

function printError(error, json) {
  if (json) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message }));
    return;
  }
  console.error(`Error: ${error.message}`);
}

export async function runCli(argv) {
  const { command, json } = parseArgs(argv);
  const handler = commands[command];
  if (!handler) {
    printError(new CliError(`Unknown command: ${command ?? '(none)'}`, 'UNKNOWN_COMMAND'), json);
    process.exitCode = 1;
    return;
  }
  try {
    printResult(await handler(), json);
  } catch (error) {
    printError(error, json);
    process.exitCode = 1;
  }
}
