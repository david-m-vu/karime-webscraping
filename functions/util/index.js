const https = require("https");
const axios = require("axios");

// use keepAlive: true to let multiple requests reuse the same TCP/TLS connection, lowering chances of CDN returning 425 Too Early error
const httpAgent = new https.Agent({ keepAlive: true }); 


/*
 * Must include User-Agent in headers because the CDN (or Web Application Firewall WAF) for kpopping likely blocks suspicious requests that
 * don't come from legitimate users, therefore returning the 403 Forbidden status code.
 * Kpopping uses a configured cloudfront CDN (which enforces rate limits, TLS/0-RTT, and cache lifetime)
 * to forward certain headers to their backend, which they end up checking
 */ 
const client = axios.create({
  timeout: 15000, // abort the request if no response completes with 15s
  httpsAgent: httpAgent,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://kpopping.com/",
    "Upgrade-Insecure-Requests": "1", // "I prefer HTTPS versions", make header set look more browser-like
  },
});

// resolve promise after given ms
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/*
 * This function is necessary due to the 425: Too Early status code. This is because of RTT-0
 * where new connections can skip the TLS handshake and move straight to sending the HTTP requests
 * without verifications. It's not guaranteed that every request goes over the same established TLS session,
 * so when we send a bunch of requests at the same time (potentially with different TLS connections), 
 * it might act as a red flag to the CDN when we're making multiple TLS connections
 */
const getWithRetry = async (url, tries = 3) => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            // set the referer to the page we're fetching from so it looks more natural
            return await client.get(url, { headers: { Referer: url }});
        } catch (err) {
            const status = err.response?.status;
            lastErr = err;

            // don't retry if status is not one of these 4 (transient statuses) or if we're on our last try
            if (![425, 429, 503, 403].includes(status) || i === tries - 1) {
                throw err;
            }

            // before retry, backoff with jitter (randomness to retry delays)
            const delay = (15000) + Math.floor(Math.random() * 400);
            console.warn(`GET ${url} failed with ${status}. Retrying in ${delay} ms...`);
            await sleep(delay);
        }
    }
    // if we made it past the loop without returning the get response, error
    throw lastErr;
}

/* 
 * Used to go from idolName="Karina2" to https://kpopping.com/kpics?idol=077c4f02-7ca6-49a6-9daf-df1dabc55d0f&idolName=Karina (image gallery)
 * which reqires us to extract the UUID.
 * note that by the time initialHTML exists, the escapes may or may not have already been interpreted. This is why the regex MIGHT need to consider the escape characters
*/
const extractIdolId = (initialHTML) => {
  // Primary: explicit idol id in hydrated Next.js data
  const primary = initialHTML.match(
    /\\?"idol\\?"\s*:\s*\{\\?"id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?"/i
  );
  if (primary) return primary[1];

  // Fallback: id embedded in signature/lightstick URL path
  const fallback = initialHTML.match(
    /\/idols\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:signature|lightstick)\.webp/i
  );
  if (fallback) return fallback[1];

  return null;
};

module.exports = { getWithRetry, extractIdolId }
