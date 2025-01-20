const {onRequest} = require("firebase-functions/v2/https");

// const cors = require("cors")({ origin: true })

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
    const fetchAlbums = async (albumURLs) => {
        const albums = [];
        for (let i = 0; i < albumURLs.length; i++) {
            const url = albumURLs[i];

            const albumRes = await axios.get(url);
            const albumHTML = albumRes.data;

            $ = cheerio.load(albumHTML)

            let pictureURLs = [];
            $(".justified-gallery a").each((index, element) => {
                pictureURLs.push({
                    thumbnailUrl: `${kpoppingBaseURL}${$(element).attr('href')}`,
                    imageUrl: `${kpoppingBaseURL}${$(element).attr('href')}`,
                });
            });

            const title = $(`meta[property="og:title"]`).attr('content')

            // console.log(`${i}: ${url}, ${title}, ${pictureURLs}`)

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
        response.send("Hi");
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