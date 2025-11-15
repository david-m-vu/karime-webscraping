const { onRequest } = require("firebase-functions/v2/https");

// const cors = require("cors")({ origin: true })

const cheerio = require("cheerio");
const axios = require("axios");
const https = require("https");

const kpoppingBaseURL = "https://kpopping.com"

// use keepAlive: true to let multiple requests reuse the same TCP/TLS connection, lowering chances of CDN returning 425 Too Early error
const httpAgent = new https.Agent({ keepAlive: true }); 

// resolve promise after given ms
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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


// Example response:
// {
//     "idolName": "chaewon2",
//     "groupName": "tripleS",
//     "albums": [
//         {
//             "url": "https://kpopping.com/kpics/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae",
//             "title": "251111 ChaeWon at Christmas Carol MV Recording in Hongdae",
//             "pictureURLs": [
//                 {
//                     "thumbnailUrl": "https://kpopping.com/documents/57/2/800/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-2.jpeg",
//                     "imageUrl": "https://kpopping.com/documents/57/2/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-2.jpeg"
//                 },
//                 {
//                     "thumbnailUrl": "https://kpopping.com/documents/80/1/800/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-1.jpeg",
//                     "imageUrl": "https://kpopping.com/documents/80/1/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-1.jpeg"
//                 },
//                 {
//                     "thumbnailUrl": "https://kpopping.com/documents/9c/5/800/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-1(1).jpeg",
//                     "imageUrl": "https://kpopping.com/documents/9c/5/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-1(1).jpeg"
//                 },
//                 {
//                     "thumbnailUrl": "https://kpopping.com/documents/8e/1/800/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-2(1).jpeg",
//                     "imageUrl": "https://kpopping.com/documents/8e/1/251111-ChaeWon-at-Christmas-Carol-MV-Recording-in-Hongdae-documents-2(1).jpeg"
//                 }
//             ]
//         },
//      ]
//  }
 

const getKPOPPictures = async (idolName) => {
    try {
        // use encodeURIComponent to encode a text string as a valid component of a Uniform Resource Identifier (URI).'
        // ex: kim chaewon turns into kim%20chaewon
        const initialURL = `https://kpopping.com/profiles/idol/${encodeURIComponent(idolName)}`;
        
        const initialRes = await getWithRetry(initialURL);
        const initialHTML = initialRes.data;

        let $ = cheerio.load(initialHTML);

        // route if idol doesn't exist
        if ($("h1").first().text() === "UH OH!") {
            return null;
        }

        // get group name
        const groupAnchor = $(`a[href*='https://kpopping.com/profiles/group/']`).first();

        let groupName = "Soloist";
        if (groupAnchor && groupAnchor.length > 0) { // if selected at least one groupAnchor
            groupName = groupAnchor.text().trim() || "Soloist";
        }

        // get all album URLs
        let albumURLs = [];
        $('.matrix a').each((index, element) => {
            albumURLs.push(`${kpoppingBaseURL}${$(element).attr('href')}`);
        });

        // get all images from each album;
        const fetchAlbums = async (albumURLs) => {
            const albums = [];
            for (let i = 0; i < albumURLs.length; i++) {
                const url = albumURLs[i];
                
                console.log(`getting album ${url}`)
                const albumRes = await getWithRetry(url);
                const albumHTML = albumRes.data;

                $ = cheerio.load(albumHTML)

                let pictureURLs = [];
                $(".justified-gallery a").each((index, element) => {
                    const imgSrc = $(element).find('img').attr('src') || ""; // Access the img element's src
                    pictureURLs.push({
                        thumbnailUrl: imgSrc ? `${kpoppingBaseURL}${imgSrc}` : "",
                        imageUrl: `${kpoppingBaseURL}${$(element).attr('href') || ""}`,
                    });
                });

                const title = $(`meta[property="og:title"]`).attr('content')

                albums.push({ url, title, pictureURLs })
            }

            return albums;
        }

        const albumsToReturn = await fetchAlbums(albumURLs);

        return {
            idolName,
            groupName,
            albums: albumsToReturn
        }
    } catch (err) {
        console.log("Error: ", err.message);
    }
}

/*
 * This function is necessary due to the 425: Too Early status code. This is because of RTT-0
 * where new connections can skip the TLS handshake and move straight to sending the HTTP requests
 * without verifications. It's not guaranteed that every request goes over the same established TLS session,
 * so when we send a bunch of requests at the same time, it might act as a red flag to the CDN when
 * we're making multiple TLS connections
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

exports.scraper = onRequest((request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    const body = request.body;

    if (!body || Object.keys(body).length === 0) {
        response.send("Hi, request body empty");
        return;
    }

    getKPOPPictures(body.idolName)
        .then((data) => {
            if (data) {
                response.send(data);
            } else {
                response.send("Idol doesn't exist");
            }
        })
        .catch((error) => {
            response.status(500).send(error.message);
        });
});