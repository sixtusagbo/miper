import * as os from 'os';
import * as path from 'path';

// Tests must never write to the operator's real ./pump.log — the default
// LOG_FILE the config resolves whenever SOURCE=pump. Point file logging at a
// throwaway temp path so `npm test` leaves the run log untouched. Tests that
// exercise the logger directly (logger.test.ts) override LOG_FILE themselves.
process.env.LOG_FILE = path.join(os.tmpdir(), 'miper-vitest.log');
