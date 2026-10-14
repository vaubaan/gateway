/**
 * The `User-Agent` of every request to Railway. Cloudflare in front of
 * `mcp.railway.com` refuses some default user agents (error 1010, seen on
 * 2026-10-14) ; a named one is sent on the MCP server and the GraphQL API alike.
 */
export const RAILWAY_USER_AGENT = 'vaubaan-gateway';
