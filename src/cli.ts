#!/usr/bin/env node
import { createNodeContext } from './core/context.js';
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), createNodeContext());
