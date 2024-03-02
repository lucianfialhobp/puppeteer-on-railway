const puppeteer = require("puppeteer");
const generateHtmlTemplate = require("./generateHtmlTemplate");
module.exports = async (req, res) => {
  const { word, translation } = req.query;

  const decodedWord = decodeURIComponent(word);
  const decodedTranslation = decodeURIComponent(translation);
  if (!word && !translation) {
    return res.status(400).send("Content query parameter is required.");
  }

  try {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Insira o CDN do Tailwind CSS no cabeçalho do HTML
    const fullHtml = generateHtmlTemplate(decodedWord, decodedTranslation);

    await page.setContent(fullHtml, {
      waitUntil: "networkidle0",
    });

    const imageBuffer = await page.screenshot({ fullPage: true });

    await browser.close();

    res.setHeader("Content-Type", "image/png");
    res.send(imageBuffer);
  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).send("Error generating image.");
  }
};