// Runtime tests must exercise this checkout, never a stale build/index.js.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),'deploy','--dry-run','--config','wrangler.staging.json','--outdir','build'],{stdio:'inherit',env:{...process.env,WRANGLER_LOG:'error'}});
if(result.error||result.status!==0) process.exit(result.status??1);
