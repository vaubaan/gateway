/**
 * The client address the request page's surface rate limit is keyed on (spec
 * §6 "surface rate limits … on the request page per IP"). The rule lives in
 * `../http/client-ip`, shared with the execution door; this module keeps the
 * names the requests module has always exported.
 */
export { clientIpOf, clientIpResolver, trustedProxyList, UNKNOWN_CLIENT } from '../http/client-ip';
