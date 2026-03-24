/**
 * Scrape Post Script
 *
 * Usage: node scripts/scrape_post.js <group_url> [--limit=10]
 *
 * This script scrapes posts from a Facebook group and shows the API request format
 * WITHOUT actually sending to the external API.
 *
 * Examples:
 *   node scripts/scrape_post.js https://www.facebook.com/groups/123456789
 *   node scripts/scrape_post.js https://www.facebook.com/groups/123456789 --limit=5
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || './playwright/session';

// Parse command line arguments
const args = process.argv.slice(2);
const groupUrl = args.find(arg => !arg.startsWith('--'));
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 5;

if (!groupUrl) {
  console.error('Usage: node scripts/scrape_post.js <group_url> [--limit=10]');
  console.error('Example: node scripts/scrape_post.js https://www.facebook.com/groups/123456789 --limit=5');
  process.exit(1);
}

// Dynamic import for clipboardy
let clipboardy = null;
const getClipboardy = async () => {
  if (!clipboardy) {
    clipboardy = (await import('clipboardy')).default;
  }
  return clipboardy;
};

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}

/**
 * Extract posts from the page with better content extraction
 */
async function extractPosts(page) {
  return await page.evaluate(() => {
    const results = [];
    const feedContainer = document.querySelector('[role="feed"]');
    if (!feedContainer) return results;

    const postElements = feedContainer.querySelectorAll(':scope > div');

    postElements.forEach((el, index) => {
      try {
        // Click "See more" buttons to expand content before extraction
        // Supports multiple languages: English, Italian, Spanish, French, German, Portuguese
        const seeMoreButtons = el.querySelectorAll('[role="button"], span[dir="auto"], div[role="button"]');
        for (const btn of seeMoreButtons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          // Check for exact matches and matches with ellipsis (...)
          if (btnText === 'see more' || btnText === 'see original' || btnText === 'continue reading' ||
              btnText === 'see more...' || btnText === 'altro' || btnText === 'altro...' ||
              btnText === 'ver más' || btnText === 'ver más...' || btnText === 'ver mais' ||
              btnText === 'ver mais...' || btnText === 'voir plus' || btnText === 'voir plus...' ||
              btnText === 'mehr anzeigen' || btnText === 'vedi altro' || btnText === 'vedi altro...' ||
              btnText === 'afficher la suite' || btnText === 'mostra altro' || btnText === 'mostra altro...' ||
              btnText === 'ler mais' || btnText === 'ler mais...') {
            try { btn.click(); } catch(e) {}
          }
        }

        // Find the actual post content container
        // Facebook posts usually have specific data attributes or structure
        let contentContainer = el;

        // Try to find the main post message area
        const messageSelectors = [
          '[data-ad-preview="message"]',
          'div[dir="auto"]',
          '.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x1vvkbs'
        ];

        let postContent = '';

        // Try to extract content more specifically
        for (const selector of messageSelectors) {
          const contentEl = el.querySelector(selector);
          if (contentEl && contentEl.textContent && contentEl.textContent.length > 20) {
            postContent = contentEl.textContent;
            break;
          }
        }

        // Fallback: use innerText but filter out "Facebook" noise
        if (!postContent) {
          const allText = el.innerText || '';
          // Filter out repeated "Facebook" text
          const lines = allText.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed !== 'Facebook' &&
              trimmed.length > 1 &&
              !trimmed.match(/^[a-z]$/i);
          });
          postContent = lines.join('\n');
        }

        if (postContent.length < 50) return;

        // Extract post ID from links
        let postId = '';
        let postUrl = '';

        const allLinks = el.querySelectorAll('a[href]');
        for (const link of allLinks) {
          const href = link.href || '';
          if (!href) continue;

          const pfbidMatch = href.match(/(pfbid[a-zA-Z0-9]+)/);
          if (pfbidMatch) {
            postId = pfbidMatch[1];
            postUrl = href.split('?')[0];
            break;
          }

          const postsMatch = href.match(/\/posts\/(\d+)/);
          if (postsMatch) {
            postId = postsMatch[1];
            postUrl = href.split('?')[0];
            break;
          }

          const permalinkMatch = href.match(/\/permalink\/(\d+)/);
          if (permalinkMatch) {
            postId = permalinkMatch[1];
            postUrl = href.split('?')[0];
            break;
          }
        }

        // Get author name
        let ownerName = '';
        let ownerProfileUrl = '';

        const authorSelectors = [
          'h2 a[href*="facebook.com"]',
          'h3 a[href*="facebook.com"]',
          'a[role="link"] strong',
          'strong a[href]'
        ];

        for (const selector of authorSelectors) {
          const authorLink = el.querySelector(selector);
          if (authorLink) {
            const href = authorLink.href || '';
            if (href && !href.includes('/posts/') && !href.includes('/groups/')) {
              ownerProfileUrl = href;
              ownerName = authorLink.textContent?.trim() || '';
              if (ownerName && ownerName.length > 2 && ownerName.length < 80) break;
            }
          }
        }

        // Generate hash ID if no post ID found
        if (!postId) {
          let hash = 0;
          const str = postContent.substring(0, 500);
          for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash;
          }
          postId = 'hash_' + Math.abs(hash);
        }

        results.push({
          post_id: postId,
          owner_name: ownerName,
          owner_profile_url: ownerProfileUrl,
          post_url: postUrl,
          raw_content: postContent,
          element_index: index
        });

      } catch (err) {
        console.error('Error extracting post:', err);
      }
    });

    return results;
  });
}

/**
 * Get post URL via share button (with retry logic)
 */
async function getPostUrlByIndex(page, index, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  Getting URL for post ${index} (attempt ${attempt}/${maxRetries})`);

      const feedContainer = await page.$('[role="feed"]');
      if (!feedContainer) {
        console.log('  Feed container not found');
        continue;
      }

      const postEls = await feedContainer.$$('> div');
      const postEl = postEls[index];
      if (!postEl) {
        console.log(`  Post element at index ${index} not found`);
        continue;
      }

      await postEl.scrollIntoViewIfNeeded();
      await randomDelay(300, 500);

      // Click share button
      const shareClicked = await postEl.evaluate((el) => {
        const btns = el.querySelectorAll('div[role="button"]');
        for (const b of btns) {
          if (b.textContent?.toLowerCase().includes('condividi')) {
            b.click();
            return true;
          }
        }
        return false;
      });

      if (!shareClicked) {
        console.log(`  Share button not found for post ${index}`);
        continue;
      }
      await randomDelay(1500, 2000);

      // Use keyboard navigation to click "Copy link" - works across all languages
      // Shift+Tab to focus on copy link button, then Enter to click it
      await page.keyboard.press('Shift+Tab');
      await delay(300);
      await page.keyboard.press('Enter');

      await delay(800);

      const clip = await getClipboardy();
      const url = await clip.read();

      await page.keyboard.press('Escape');
      await randomDelay(200, 400);

      if (url && url.includes('facebook.com')) {
        console.log(`  Successfully got URL: ${url}`);
        return url;
      } else {
        console.log(`  Invalid URL from clipboard: ${url}`);
      }

    } catch (err) {
      console.log(`  Error getting URL (attempt ${attempt}): ${err.message}`);
      await page.keyboard.press('Escape').catch(() => { });
    }

    // Delay before retry
    if (attempt < maxRetries) {
      await randomDelay(500, 1000);
    }
  }

  return null;
}

/**
 * Expand all "See more" buttons on the page
 * Supports multiple languages: English, Italian, Spanish, French, German, Portuguese
 */
async function expandAllSeeMoreButtons(page) {
  try {
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('[role="button"], span[dir="auto"], div[role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        // Check for exact matches and matches with ellipsis (...)
        if (text === 'see more' || text === 'see original' || text === 'continue reading' ||
            text === 'see more...' || text === 'altro' || text === 'altro...' ||
            text === 'ver más' || text === 'ver más...' || text === 'ver mais' ||
            text === 'ver mais...' || text === 'voir plus' || text === 'voir plus...' ||
            text === 'mehr anzeigen' || text === 'vedi altro' || text === 'vedi altro...' ||
            text === 'afficher la suite' || text === 'mostra altro' || text === 'mostra altro...' ||
            text === 'ler mais' || text === 'ler mais...') {
          try {
            btn.click();
          } catch (e) {}
        }
      }
    });
    await delay(500);
  } catch (e) {
    // Ignore errors
  }
}

/**
 * Construct post URL from post ID as fallback
 */
function constructPostUrlFromId(postId, groupId) {
  if (!postId) return null;
  if (postId.startsWith('hash_')) return null;
  if (postId.startsWith('pfbid')) {
    return `https://www.facebook.com/${postId}`;
  }
  if (/^\d+$/.test(postId)) {
    return `https://www.facebook.com/groups/${groupId}/posts/${postId}`;
  }
  return null;
}

/**
 * Parse content to extract structured data
 */
function parseContent(rawContent) {
  // Clean up the content
  let cleanContent = rawContent
    .replace(/(Facebook\n?)+/g, '')
    .replace(/^[a-z\d\s]{1,3}\n/gm, '')
    .replace(/Write a public comment.*/gs, '')
    .replace(/Like\nComment\nShare/g, '')
    .replace(/See more|See less|See original|Rate this translation/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Extract title (first meaningful line)
  const lines = cleanContent.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10 && l.length < 200);

  let title = '';
  for (const line of lines) {
    if (line.split(' ').length >= 2 && !line.includes('·')) {
      title = line;
      break;
    }
  }

  // Extract price
  let price = null;
  const priceMatch = cleanContent.match(/[\$€£][\d,]+/);
  if (priceMatch) {
    price = priceMatch[0];
  }

  // Extract location
  let location = null;
  const locationMatch = cleanContent.match(/(?:location|area|address|in|at)[\s:]+([^\n,]{3,50})/i);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  // Extract contact info
  let contact_info = null;
  const phoneMatch = cleanContent.match(/(\+?\d[\d\s\-().]{8,})/);
  if (phoneMatch) {
    contact_info = phoneMatch[1].trim();
  }

  // Extract email
  let email = null;
  const emailMatch = cleanContent.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    email = emailMatch[0].toLowerCase();
  }

  // Determine listing type
  let listing_type = 'sale';
  const lower = cleanContent.toLowerCase();
  if (/rent|lease|affitto/i.test(lower)) {
    listing_type = 'rent';
  }

  // Determine property type
  let property_type = 'residential';
  if (/office|commercial|shop|store/i.test(lower)) {
    property_type = 'commercial';
  } else if (/land|plot|lot|terrain/i.test(lower)) {
    property_type = 'land';
  }

  return {
    title,
    price,
    location,
    contact_info,
    email,
    listing_type,
    property_type,
    raw_content: cleanContent
  };
}

/**
 * Build API request payload for a post
 */
function buildApiPayload(post, groupUrl) {
  const parsed = parseContent(post.raw_content);

  // Extract group ID from URL
  const groupMatch = groupUrl.match(/groups\/([^/?]+)/);
  const facebookGroupId = groupMatch ? groupMatch[1] : groupUrl;

  // Parse name
  const nameParts = (post.owner_name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Parse price
  let estimatedPrice = null;
  if (parsed.price) {
    const cleaned = parsed.price.replace(/[$€£,]/g, '');
    estimatedPrice = parseFloat(cleaned) || null;
  }

  return {
    agency_id: parseInt(process.env.DEFAULT_AGENCY_ID) || 1,
    group: {
      facebook_group_id: facebookGroupId,
      name: ''
    },
    post: {
      facebook_post_id: post.post_id,
      author_name: post.owner_name || '',
      message: parsed.raw_content || '',
      post_type: parsed.listing_type === 'rent' ? 'rent_offer' : 'selling',
      property_type: parsed.property_type,
      permalink: post.post_url || ''
    },
    prospect_contact: {
      first_name: firstName,
      last_name: lastName,
      phone: parsed.contact_info || '',
      email: parsed.email || '',
      force: false
    },
    news_lead: {
      title: parsed.title || '',
      description: parsed.raw_content || '',
      address: parsed.location || '',
      estimated_price: estimatedPrice,
      property_type: parsed.property_type
    }
  };
}

async function main() {
  console.log('=== Scrape Post Script ===');
  console.log(`Group URL: ${groupUrl}`);
  console.log(`Limit: ${limit} posts`);
  console.log('');

  console.log('Initializing browser...');
  const context = await chromium.launchPersistentContext(
    path.resolve(SESSION_PATH),
    {
      headless: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      locale: 'en-US'
    }
  );

  const page = await context.newPage();

  try {
    console.log(`Navigating to: ${groupUrl}`);
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[role="feed"]', { timeout: 30000 }).catch(() => { });
    await randomDelay(3000, 5000);

    console.log('Page loaded. Extracting posts...\n');

    // Extract group ID for URL construction
    const groupMatch = groupUrl.match(/groups\/([^/?]+)/);
    const groupId = groupMatch ? groupMatch[1] : null;

    const collectedPosts = new Map();
    let scrollCount = 0;

    while (collectedPosts.size < limit && scrollCount < 10) {
      scrollCount++;
      console.log(`--- Scroll #${scrollCount} (collected: ${collectedPosts.size}/${limit}) ---`);

      // Expand "See more" buttons before extraction
      await expandAllSeeMoreButtons(page);

      const posts = await extractPosts(page);

      for (const post of posts) {
        if (post.post_id && !collectedPosts.has(post.post_id)) {
          // Try to get URL via share button for first few posts
          if (!post.post_url && collectedPosts.size < 3) {
            const url = await getPostUrlByIndex(page, post.element_index, 2);
            if (url) {
              post.post_url = url;
              // Update post_id from URL
              const match = url.match(/(pfbid[a-zA-Z0-9]+)|\/posts\/(\d+)|\/permalink\/(\d+)/);
              if (match) {
                post.post_id = match[1] || match[2] || match[3];
              }
            }
          }

          collectedPosts.set(post.post_id, post);

          if (collectedPosts.size >= limit) break;
        }
      }

      if (collectedPosts.size < limit) {
        // Scroll down
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight * 1.5);
        });
        await randomDelay(2000, 4000);
      }
    }

    // Second pass: Retry empty URLs
    console.log('\n--- Second pass: Retrying empty URLs ---');
    let retryCount = 0;
    let successCount = 0;

    for (const [postId, post] of collectedPosts) {
      if (!post.post_url || post.post_url.startsWith('hash_')) {
        retryCount++;
        console.log(`Retrying URL for post ${postId}...`);

        // Method 1: Retry getPostUrlByIndex with more attempts
        let url = await getPostUrlByIndex(page, post.element_index, 3);

        // Method 2: Try to construct URL from post ID
        if (!url && groupId) {
          url = constructPostUrlFromId(postId, groupId);
          if (url) {
            console.log(`  Constructed URL from post ID: ${url}`);
          }
        }

        if (url) {
          post.post_url = url;
          // Update post_id from URL
          const match = url.match(/(pfbid[a-zA-Z0-9]+)|\/posts\/(\d+)|\/permalink\/(\d+)/);
          if (match) {
            post.post_id = match[1] || match[2] || match[3];
          }
          successCount++;
          console.log(`  Successfully retrieved URL for post ${postId}`);
        }
      }
    }

    console.log(`URL retry complete: ${successCount}/${retryCount} URLs recovered\n`);

    console.log(`\n=== Collected ${collectedPosts.size} Posts ===\n`);

    // Show API request format for each post
    let index = 1;
    for (const [postId, post] of collectedPosts) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`POST #${index} - ID: ${postId}`);
      console.log('='.repeat(60));

      console.log('\n--- Extracted Data ---');
      console.log(`Author: ${post.owner_name || 'N/A'}`);
      console.log(`Author Profile: ${post.owner_profile_url || 'N/A'}`);
      console.log(`Post URL: ${post.post_url || 'N/A'}`);
      console.log(`Content Preview: ${(post.raw_content || '')}...`);

      console.log('\n--- API Request Payload ---');
      const payload = buildApiPayload(post, groupUrl);
      console.log(JSON.stringify(payload, null, 2));

      index++
    }

    console.log(`\n\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total posts extracted: ${collectedPosts.size}`);
    console.log(`Posts with URL: ${Array.from(collectedPosts.values()).filter(p => p.post_url).length}`);
    console.log('\nNOTE: No data was sent to the external API.');
    console.log('To send data, use the main scraper or API endpoints.');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await context.close();
  }
}

main().catch(console.error);
