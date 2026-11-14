# Third-party components

This Worker uses Cloudflare's `@cloudflare/workers-oauth-provider` 1.2.3 (MIT), with the license shipped in its npm package. Development tooling includes Wrangler 4.158.0 (MIT OR Apache-2.0), Miniflare 5.20261104.0-beta (MIT) and TypeScript 7.0.2 (Apache-2.0). The npm lock records the complete dependency graph and integrity hashes. Install from the registry to obtain their complete license texts. Installed node_modules are excluded. The static website includes GSAP and ScrollTrigger 3.15.1 minified browser bundles under public/vendor/gsap; their original copyright/license headers and SOURCE.txt provenance are retained. Those files are governed by the GSAP Standard License (https://gsap.com/standard-license/), not PCRC's proprietary license.

Cloudflare's remote MCP GitHub example was reviewed for architecture at https://github.com/cloudflare/ai/tree/0e5bc3b2f489e4b8215905812a36fe69d37afb8d/demos/remote-mcp-github-oauth ; it is a reference, not vendored source.

The separately downloaded cloudflared executable is distributed by Cloudflare under its own upstream license and notices: https://github.com/cloudflare/cloudflared . This archive contains the pinned URL/digest and audit records, not the executable.
