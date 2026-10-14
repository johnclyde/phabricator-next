#!/usr/bin/env node
import { register } from 'tsx/esm/api';

// Resolve the CLI from its installation, without loading the caller's tsconfig.
register({ tsconfig: false });
await import('../cli/index.ts');
