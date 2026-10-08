// Worker bootstrap: register the TypeScript loader inside this thread, then load the worker.
// (Loaders the main thread started with are not inherited by worker threads.)
import { register } from 'tsx/esm/api';

register();
await import('./matchworker.ts');
