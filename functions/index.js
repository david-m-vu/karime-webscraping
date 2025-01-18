/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// const {onRequest} = require("firebase-functions/v2/https");
// const logger = require("firebase-functions/logger");

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const functions = require("firebase-functions");


const cors = require("cors")({ origin: true })

const cheerio = require("cheerio");
const axios = require("axios");

const kpoppingBaseURL = "https://kpopping.com"

const getKPOPPictures = async (idolName) => {
    const initialURL = `https://kpopping.com/profiles/idol/${idolName}`;
    const initialRes = await axios.get(initialURL);

    const initialHTML = initialRes.data;

    let $ = cheerio.load(initialHTML);

    if ($("h1").first().text() === "UH OH!") {
        return null;
    }

    //get group name
    const groupAnchor = $(`a[href*='https://kpopping.com/profiles/group/']`).first();

    let groupName;
    if (!groupAnchor) {
        groupName = "Soloist"
    }
    groupName = groupAnchor.text();

    // // get all album URLs
    let albumURLs = [];
    $('.matrix a').each((index, element) => {
        albumURLs.push(`${kpoppingBaseURL}${$(element).attr('href')}`);
    });
    
    // get all images from each album;
    const fetchAlbumsWithDelay = async (albumURLs) => {
        const albums = [];
        for (let i = 0; i < albumURLs.length; i++) {
            const url = albumURLs[i];

            const albumRes = await axios.get(url);
            const albumHTML = albumRes.data;

            $ = cheerio.load(albumHTML)

            let pictureURLs = [];
            $(".justified-gallery a").each((index, element) => {
                pictureURLs.push(`${kpoppingBaseURL}${$(element).attr('href')}`);
            });

            const title = $(`meta[property="og:title"]`).attr('content')

            console.log(`${i}: ${url}, ${title}, ${pictureURLs}`)

            albums.push({ url, title, pictureURLs })
        }

        return albums;
    }

    const albumsToReturn = await fetchAlbumsWithDelay(albumURLs);

    return {
        idolName,
        groupName,
        albums: albumsToReturn
    }
}

exports.scraper = functions.https.onRequest((request, response) => {
    cors(request, response, async () => {
        const body = request.body;

        if (Object.keys(body).length === 0) response.send("Hi")

        const data = await getKPOPPictures(body.idolName)

        if (data) {
            response.send(data);
        } else {
            response.send("Idol doesn't exist")
        }
    })
})