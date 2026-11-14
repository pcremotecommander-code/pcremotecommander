'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const esbuild=require(path.join(root,'deploy/cloudflare/worker/node_modules/esbuild'));
const source=fs.readFileSync(path.join(root,'deploy/mcp-task-server/src/privacy-guard.ts'),'utf8');
const output='// Generated from deploy/mcp-task-server/src/privacy-guard.ts.\n'+esbuild.transformSync(source,{loader:'ts',format:'cjs',platform:'node',target:'node20'}).code;
fs.writeFileSync(path.join(root,'deploy/npm/jan-commander/bin/privacy-guard.cjs'),output);
