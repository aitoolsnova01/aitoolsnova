import fs from "fs-extra";
import path from "path";
import axios from "axios";
import slugify from "slugify";

const CONFIG = {
  siteName: "AIToolsNova",
  siteUrl: "https://aitoolsnova.com",
  blogDir: "./blog",
  indexFile: "./blogs.html",
  sitemapFile: "./sitemap.xml",
  logDir: "./logs",
  maxRetries: 3,
  timeout: 60000
};

const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error("❌ GROQ_API_KEY not found.");
  process.exit(1);
}

await fs.ensureDir(CONFIG.blogDir);
await fs.ensureDir(CONFIG.logDir);

function timestamp() {
  return new Date().toISOString();
}

async function writeLog(message) {
  const file = path.join(CONFIG.logDir, "blog.log");
  await fs.appendFile(file, `[${timestamp()}] ${message}\n`);
}

function createSlug(title) {
  return slugify(title, {
    lower: true,
    strict: true,
    trim: true
  });
}

async function fileExists(file) {
  return fs.pathExists(file);
}

async function loadJson(file, fallback = []) {
  if (!(await fileExists(file))) return fallback;
  return fs.readJson(file);
}

async function saveJson(file, data) {
  await fs.writeJson(file, data, { spaces: 2 });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestGroq(messages) {

  const url = "https://api.groq.com/openai/v1/chat/completions";

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {

    try {

      const response = await axios.post(
        url,
        {
          model: "llama-3.3-70b-versatile",
          temperature: 0.7,
          messages
        },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: CONFIG.timeout
        }
      );

      return response.data.choices[0].message.content;

    } catch (err) {

      await writeLog(`Groq Attempt ${attempt} Failed`);

      if (attempt === CONFIG.maxRetries) {
        throw err;
      }

      await sleep(3000);

    }

  }

}

console.log("✅ Core Engine Loaded");
await writeLog("Core Engine Started");


const KEYWORD_FILE = "./data/keywords.json";
const PUBLISHED_FILE = "./data/published.json";

async function getNextKeyword() {

  const keywords = await loadJson(KEYWORD_FILE, []);
  const published = await loadJson(PUBLISHED_FILE, []);

  const remaining = keywords.filter(
    keyword => !published.includes(keyword)
  );

  if (remaining.length === 0) {
    throw new Error("No keywords remaining.");
  }

  const keyword =
    remaining[Math.floor(Math.random() * remaining.length)];

  return keyword;

}

async function markKeywordPublished(keyword) {

  const published = await loadJson(PUBLISHED_FILE, []);

  if (!published.includes(keyword)) {

    published.push(keyword);

    await saveJson(PUBLISHED_FILE, published);

  }

}

async function generateSlug(keyword) {

  return createSlug(keyword);

}

async function main() {

  const keyword = await getNextKeyword();

  console.log("Selected Keyword:", keyword);

  await writeLog(`Keyword Selected: ${keyword}`);

  const article = await generateBlog(keyword);

const slug = await generateSlug(keyword);

console.log("Slug:", slug);

await markKeywordPublished(keyword);

console.log("Keyword marked as published");

  console.log(article);

  await writeLog("Blog Generated Successfully");

  return {
  keyword,
  slug,
  article
};

}

await main();

async function generateBlog(keyword) {

  const prompt = `
Write a detailed SEO optimized blog about:

${keyword}

Requirements:

- 2000+ words
- Human readable
- H1 Title
- Meta Description
- Introduction
- Table of Contents
- H2 & H3 headings
- FAQs
- Conclusion
- Use Markdown formatting
`;

  const article = await requestGroq([
    {
      role: "user",
      content: prompt
    }
  ]);

  return article;

}
