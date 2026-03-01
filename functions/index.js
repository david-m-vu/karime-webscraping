const { getWithRetry, extractIdolId } = require("./util")

const { onRequest } = require("firebase-functions/v2/https");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

const kpoppingBaseURL = "https://kpopping.com"

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
 
const getKpopPicturesV1 = async (idolName) => {
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

const getKpopPicturesV2 = async (idolName) => {
    try {
        const initialURL = `https://kpopping.com/profiles/idol/${encodeURIComponent(idolName)}`;

        const initialRes = await getWithRetry(initialURL);
        const initialHTML = initialRes.data;

        const $ = cheerio.load(initialHTML);

        // , means match either selector
        const groupAnchor = $('a[href^="/profiles/group/"], a[href*="https://kpopping.com/profiles/group/"]').first();
        const groupName = (groupAnchor.length > 0) ? ((groupAnchor.text() || "").trim() || "N/A") : "N/A";

        // get idol UUID to get the idol's image gallery URL
        const idolUUID = extractIdolId(initialHTML);
        console.log(idolUUID);
        if (!idolUUID) {
            throw new Error("Could not extract idol UUID from initial HTML");
        }

        const imageGalleryURL = `${kpoppingBaseURL}/kpics?idol=${idolUUID}&idolName=${encodeURIComponent(idolName)}`;

        // puppeteer step
        const browser = await puppeteer.launch({
            headless: "new", // run chrome without visible UI using puppeteer's newer headless mode, true is legacy
            args: ["--no-sandbox", "--disable-setuid-sandbox"], // disable Chrome sandbox and setuid sandbox fallback
        })

        try {
            // open a blank page
            const page = await browser.newPage();
            // networkIdle2 waits until there are no more than 2 network connections for at least 500ms (implying that page is mostly loaded)
            await page.goto(imageGalleryURL, { waitUntil: "networkidle2", timeout: 60000 });

            const gridSelector = 'div[class*="grid-cols-3"][class*="md:grid-cols-4"][class*="gap-3"]';
            // wait for any anchor tag that has an href attribute inside of grid selector, regardless of its value
            await page.waitForSelector(`${gridSelector} a[href]`, {timeout: 30000 });

            // $$eval returns all elements matching the selector and passes the resulting array as the first argument to the callback
            const albumURLs = await page.$$eval(`${gridSelector} a[href]`, (anchors) => {
                return anchors
                    .map((a) => a.getAttribute("href"))
                    .filter((href) => typeof href === "string" && href.length > 0)
            })

            // attach href to absolute URL just in case hrefs are relative
            // (if href is relative, it combines with the base. if href is already absolute, it keeps it as-is)
            const absoluteAlbumURLs = albumURLs.map((href) => new URL(href, kpoppingBaseURL).toString());
            console.log(absoluteAlbumURLs);

            const albumImageURLs = [];
            const albumImageSelector = 'div.overflow-x-auto div.flex[style*="gap: 8px"] button img[src]';
            const singleImageSelector = 'div.relative.w-full.cursor-pointer.group img[src]';

            for (const albumURL of absoluteAlbumURLs) {
                console.log(`fetching image URLs from ${albumURL}`)
                await page.goto(albumURL, { waitUntil: "networkidle2", timeout: 60000 });

                // get album title
                const title = await page.$eval("article h1, h1", (elem) => elem.textContent.trim())

                let imageURLs = [];

                try {
                    // Multi-image albums: image strip of button thumbnails.
                    await page.waitForSelector(albumImageSelector, { timeout: 5000 });
                    imageURLs = await page.$$eval(albumImageSelector, (images) => {
                        const srcs = images
                            .map((img) => img.getAttribute("src"))
                            .filter((src) => typeof src === "string" && src.length > 0);

                        return [...new Set(srcs)];
                    });
                } catch { // if the above times out (because this album only has one image)
                    // Single-image albums: fallback to main displayed image.
                    await page.waitForSelector(singleImageSelector, { timeout: 30000 });
                    imageURLs = await page.$$eval(singleImageSelector, (images) => {
                        const srcs = images
                            .map((img) => img.getAttribute("src"))
                            .filter((src) => typeof src === "string" && src.length > 0);

                        return [...new Set(srcs)];
                    });
                }

                // for backwards compatibility
                const pictureURLs = imageURLs.map((imageURL) => {
                    return {
                        thumbnailUrl: imageURL
                    }
                })

                albumImageURLs.push({
                    url: albumURL,
                    title,
                    pictureURLs,
                });
            }

            return {
                idolName,
                groupName,
                albums: albumImageURLs,
            };

        } finally { // catch propogates to the caller, so caller handles it
            await browser.close();
        }
        
    } catch (err) {
        console.log("Error: ", err.message);
    }
}

exports.getKpopPicturesV2 = onRequest((request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    // handle browser preflight request
    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    const body = request.body;

    if (!body || Object.keys(body).length === 0) {
        response.send("Hi, request body empty");
        return;
    }

    getKpopPicturesV2(body.idolName).then((data) => {
        if (data) {
            response.send(data);
        } else {
            response.send("Something went wrong")
        }
    }).catch((error) => {
        response.status(500).send(error.message);
    });

});

exports.getKpopPicturesV1 = onRequest((request, response) => {
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

    getKpopPicturesV1(body.idolName)
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
