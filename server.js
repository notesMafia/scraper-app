import express from "express";
import multer from "multer";
import cors from "cors";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import RecaptchaPlugin from "puppeteer-extra-plugin-recaptcha";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import csvParser from "csv-parser";
import { stringify } from "csv-stringify/sync";
import { WebSocketServer } from "ws";

puppeteer.use(StealthPlugin());
puppeteer.use(RecaptchaPlugin({ provider: { id: "2captcha", token: "YOUR_2CAPTCHA_API_KEY" } }));

const app = express();
const PORT = process.env.PORT || 5000;

// Fix `__dirname` in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create required directories
const uploadDir = path.join(__dirname, "uploads");
const downloadDir = path.join(__dirname, "downloads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

// Setup file upload
const upload = multer({ dest: uploadDir });

// WebSocket Server for real-time updates
const clients = new Set();
let isScraping = false;
let lastOutputFile = "";
let lastNotFoundFile = "";

// WebSocket for real-time progress updates
const wss = new WebSocketServer({ port: 5001 });
wss.on("connection", (ws) => clients.add(ws));

const sendProgress = (message) => {
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ message }));
    }
  }
};

// Read CSV File
function readWebsitesFromCSV(filename) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filename)
      .pipe(csvParser())
      .on("data", (row) => records.push(row))
      .on("end", () => resolve(records))
      .on("error", (error) => reject(error));
  });
}

// Clean email (remove query parameters)
const cleanEmail = (email) => email.split("?")[0].trim();

// Write emails to CSV
function writeEmailToCSV(filePath, record, emails) {
  const cleanedEmails = emails.map(cleanEmail).filter(email => email.includes("@"));
  if (cleanedEmails.length > 0) {
    const csvRows = cleanedEmails.map(email => ({
      "Business Name": record["Business Name"],
      "Category": record["Category"],
      "Address": record["Address"] || "No",
      "Postal Code": record["Postal Code"],
      "Phone Number": record["Phone Number"],
      "Website": record["Website"],
      "Email": email
    }));

    const csvData = stringify(csvRows, { header: false });
    fs.appendFileSync(filePath, csvData);
  }
}

// Write failed websites to Notfound.txt
function writeNotFoundDomain(filePath, domain) {
  fs.appendFileSync(filePath, domain + "\n");
}

// Scrape emails from a website
async function scrapeEmails(url, browser) {
  let emails = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 ... Safari/537.36");
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      console.log(`❌ Failed to load ${url}`);
      await page.close();
      return [];
    }

    let mailtoEmails = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href^='mailto:']"))
        .map(link => link.href.replace("mailto:", "").trim())
    );

    emails = [...new Set(mailtoEmails)];
    console.log(`📧 Emails found on ${url}:`, emails.length ? emails : "No emails");
    await page.close();
  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
  }
  return emails;
}

// Scrape contact pages for emails
async function scrapeContactPages(mainUrl, browser) {
  const contactPaths = [
    "/contact", "/contactus", "/contact-us", "/support", "/help",
    "/customer-service", "/get-in-touch", "/reach-us", "/about", "/about-us"
  ];

  for (let path of contactPaths) {
    let emails = await scrapeEmails(new URL(path, mainUrl).href, browser);
    if (emails.length) return emails;
  }
  return [];
}

// Scraper Function with Stop Capability
async function scrapeWebsites(filePath) {
  isScraping = true;
  const websites = await readWebsitesFromCSV(filePath);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  lastOutputFile = path.join(downloadDir, `Emails_${timestamp}.csv`);
  lastNotFoundFile = path.join(downloadDir, `Notfound_${timestamp}.txt`);
  fs.writeFileSync(lastOutputFile, "Business Name,Category,Address,Postal Code,Phone Number,Website,Email\n");

  for (let i = 0; i < websites.length; i++) {
    if (!isScraping) break;

    const record = websites[i];
    const site = record["Website"]?.trim();
    if (!site) continue;

    const domain = new URL(site).hostname.replace("www.", "");
    sendProgress(`Scraping: ${site} (${i + 1}/${websites.length})`);

    let emails = await scrapeEmails(site, browser);
    if (!emails.length) emails = await scrapeContactPages(site, browser);

    if (emails.length) {
      writeEmailToCSV(lastOutputFile, record, emails);
    } else {
      writeNotFoundDomain(lastNotFoundFile, domain);
    }
  }

  await browser.close();
  isScraping = false;
  sendProgress("Scraping complete.");
}

// API: Upload CSV and Start Scraping
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  sendProgress("Starting scraping process...");
  await scrapeWebsites(req.file.path);

  res.json({ success: true, downloadUrl: `/download/${path.basename(lastOutputFile)}` });
});

// API: Stop Scraping
app.post("/stop", (req, res) => {
  isScraping = false;
  sendProgress("Scraping stopped by user.");
  res.json({ success: true, message: "Scraping process stopped." });
});

// API: Get Latest Scraped File
app.get("/latest-file", (req, res) => {
  res.json({ success: true, filename: path.basename(lastOutputFile) });
});

// API: Get Not Found File
app.get("/notfound-file", (req, res) => {
  res.json({ success: true, filename: path.basename(lastNotFoundFile) });
});

// API: Serve Downloaded Files
app.get("/download/:filename", (req, res) => {
  const file = path.join(downloadDir, req.params.filename);
  res.download(file, (err) => {
    if (err) res.status(500).json({ error: "File not found" });
  });
});
app.get("/scraping-status", (req, res) => {
  res.json({ isScraping });
});
// Start Server
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
