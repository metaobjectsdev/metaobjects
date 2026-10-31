// The process reaper-kill.test.ts kills: it starts a real helper container, reports the port and
// waits. It never stops the container, because the test ends this process before it could.

import { startPostgres } from "../src/postgres-container.ts";

const pg = await startPostgres();
console.log(`READY ${new URL(pg.connectionUri).port}`);
setTimeout(() => {}, 600_000);
