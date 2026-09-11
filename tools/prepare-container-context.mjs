#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containerContextManifestName,
  prepareContainerContext,
} from './isolated-runner-lib.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tools/prepare-container-context.mjs --output <path> [--include-candidates]');
  } else {
    const destinationRoot = resolve(options.output);
    const manifest = await prepareContainerContext({
      repositoryRoot,
      destinationRoot,
      includeCandidates: options.includeCandidates,
    });
    console.log(`[context] copied ${manifest.copied.tracked.length} tracked files`);
    if (options.includeCandidates) {
      console.log(`[context] copied ${manifest.copied.candidates.length} opt-in candidate files`);
    }
    console.log(`[context] review ${resolve(destinationRoot, containerContextManifestName)}`);
  }
} catch (error) {
  console.error(`[context] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  let output;
  let includeCandidates = false;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') help = true;
    else if (argument === '--include-candidates') includeCandidates = true;
    else if (argument === '--output') {
      output = arguments_[index + 1];
      if (!output) throw new Error('--output requires a path');
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  if (!help && !output) throw new Error('--output is required');
  return { help, includeCandidates, output };
}
