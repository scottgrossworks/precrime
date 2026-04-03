/*
 * precrime_rss_scorer.js
 *
 * MCP Server for Pre-Crime Enrichment — RSS Article Scorer
 *
 * ONE tool: get_top_articles
 * - Fetches RSS feeds from configured sources
 * - Scores articles based on keyword matching
 * - Returns top N articles (URLs + metadata) for factlet evaluation
 *
 * NO DATABASE - Just scoring and URL delivery
 * Config: rss_config.json (generated from deployment manifest)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import Parser from 'rss-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load configuration
const CONFIG = JSON.parse(readFileSync(join(__dirname, 'rss_config.json'), 'utf8'));
const parser = new Parser();

console.error('='.repeat(60));
console.error('Pre-Crime RSS Scorer MCP Server');
console.error('='.repeat(60));
console.error(`Feeds configured: ${CONFIG.feeds.length}`);
console.error(`Global keywords: ${CONFIG.keywords.global.length}`);
console.error(`Relevance threshold: ${CONFIG.processing.relevanceThreshold} points`);
console.error('='.repeat(60));


function cleanAndTrim(content) {
  if (!content) return { trimmed: '', original: 0, final: 0 };

  const originalLength = content.length;
  let text = content;

  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const boilerplatePatterns = [
    /follow us on (twitter|facebook|instagram|linkedin|social media)/gi,
    /subscribe to our (newsletter|channel|feed)/gi,
    /sign up for (our |the )?(newsletter|updates|email)/gi,
    /share this article/gi,
    /related articles?:/gi,
    /recommended for you/gi,
    /you may also like/gi,
    /advertisement/gi,
    /sponsored content/gi,
    /read more:/gi,
    /continue reading/gi,
    /click here to/gi,
    /\[ad_\d+\]/gi,
  ];

  boilerplatePatterns.forEach(pattern => { text = text.replace(pattern, ''); });

  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, ' ').trim();

  const charLimit = CONFIG.processing.contentCharLimit || 600;
  if (text.length > charLimit) {
    const cutPoint = text.lastIndexOf('.', charLimit);
    text = (cutPoint > charLimit * 0.8) ? text.substring(0, cutPoint + 1) : text.substring(0, charLimit);
  }

  return { trimmed: text, original: originalLength, final: text.length };
}


function filterAndScoreItems(items, feedConfig) {
  const nonVideoItems = items.filter(item => !(item.link || '').includes('-video'));

  const blacklist = CONFIG.blacklist || [];
  const nonDealsItems = nonVideoItems.filter(item => {
    const title = (item.title || '').toLowerCase();
    const link  = (item.link  || '').toLowerCase();
    return !blacklist.some(p => title.includes(p) || link.includes(p));
  });

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const recentItems = nonDealsItems.filter(item => {
    if (!item.pubDate) return true;
    return new Date(item.pubDate) >= oneYearAgo;
  });

  const sc = CONFIG.scoring || {
    globalKeywordWeight: 1, feedKeywordWeight: 2, multiplier: 1,
    maxKeywordMatches: 5, recencyBonus: 10, fullContentBonus: 5
  };

  const scoredItems = recentItems.map(item => {
    const text = `${item.title} ${item.contentSnippet || ''}`.toLowerCase();
    let score = 0;

    (CONFIG.keywords?.global || []).forEach(kw => {
      const matches = Math.min((text.match(new RegExp(kw.toLowerCase(), 'gi')) || []).length, sc.maxKeywordMatches);
      score += matches * sc.globalKeywordWeight * sc.multiplier;
    });

    (feedConfig.keywords || []).forEach(kw => {
      const matches = Math.min((text.match(new RegExp(kw.toLowerCase(), 'gi')) || []).length, sc.maxKeywordMatches);
      score += matches * sc.feedKeywordWeight * sc.multiplier;
    });

    if (item.pubDate && (Date.now() - new Date(item.pubDate).getTime()) < 86400000) {
      score += sc.recencyBonus;
    }

    const hasFullContent = item.content && item.content.length > 500;
    if (hasFullContent) score += sc.fullContentBonus;

    let trimmedContent = undefined;
    let contentStats = null;
    if (hasFullContent) {
      const r = cleanAndTrim(item.content);
      trimmedContent = r.trimmed;
      contentStats = { original: r.original, final: r.final, reduction: Math.round((1 - r.final / r.original) * 100) };
    }

    return {
      url: item.link, title: item.title, pubDate: item.pubDate,
      feedName: feedConfig.name, category: feedConfig.category, score,
      snippet: (item.contentSnippet || '').substring(0, 200),
      hasFullContent, content: trimmedContent, contentStats
    };
  });

  return scoredItems.sort((a, b) => b.score - a.score);
}


async function fetchFeed(feedConfig) {
  try {
    return await parser.parseURL(feedConfig.url);
  } catch (error) {
    console.error(`Error fetching feed ${feedConfig.name}: ${error.message}`);
    return null;
  }
}


async function getTopArticles(limit = 6) {
  const startTime = Date.now();
  const allArticles = [];
  const totalFeeds = CONFIG.feeds.length;

  console.error(`\nProcessing ${totalFeeds} feeds, target: ${limit} articles`);

  for (let i = 0; i < CONFIG.feeds.length; i++) {
    const feedConfig = CONFIG.feeds[i];
    try {
      console.error(`[${i+1}/${totalFeeds}] ${feedConfig.name}...`);
      const feed = await fetchFeed(feedConfig);
      if (!feed) continue;

      const scoredItems = filterAndScoreItems(feed.items, feedConfig);
      const relevantItems = scoredItems.filter(item => item.score >= CONFIG.processing.relevanceThreshold);
      allArticles.push(...relevantItems);

      console.error(`  ✓ ${relevantItems.length} above threshold`);

      if (CONFIG.processing.earlyExitEnabled) {
        const top = allArticles.sort((a, b) => b.score - a.score).slice(0, CONFIG.processing.earlyExitCount);
        if (top.length >= CONFIG.processing.earlyExitCount &&
            top.every(a => a.score >= CONFIG.processing.earlyExitMinScore)) {
          console.error(`EARLY EXIT after ${i+1} feeds`);
          break;
        }
      }
    } catch (error) {
      console.error(`  ✗ Error: ${error.message}`);
    }
  }

  const sorted = allArticles.sort((a, b) => b.score - a.score);
  const maxPerFeed = CONFIG.processing.maxArticlesPerFeed;
  let result = sorted;

  if (maxPerFeed) {
    const counts = {};
    result = sorted.filter(a => {
      counts[a.feedName] = (counts[a.feedName] || 0) + 1;
      return counts[a.feedName] <= maxPerFeed;
    });
  }

  const final = result.slice(0, limit);
  console.error(`Done in ${((Date.now() - startTime)/1000).toFixed(1)}s — returning ${final.length} articles`);
  return final;
}


const server = new Server(
  { name: 'precrime-rss-scorer', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'get_top_articles',
    description: 'Get highest-scoring articles from configured RSS feeds for enrichment',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of articles to return (default: 6)', default: 6 }
      }
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'get_top_articles') {
    const articles = await getTopArticles(request.params.arguments?.limit || 6);
    return { content: [{ type: 'text', text: JSON.stringify(articles) }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
server.connect(transport);
console.error('Pre-Crime RSS Scorer MCP Server running');
