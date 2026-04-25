/**
 * Marketplace Scraper Test Script
 *
 * Usage: node scripts/test_marketplace_scraper.js [--category=propertyrentals|propertyforsale|both] [--limit=10] [--detail]
 *
 * DRY RUN - scrapes marketplace cards and shows extracted data
 * WITHOUT saving to DB or sending to the external API.
 *
 * Examples:
 *   node scripts/test_marketplace_scraper.js
 *   node scripts/test_marketplace_scraper.js --category=propertyrentals --limit=5
 *   node scripts/test_marketplace_scraper.js --category=both --limit=10 --detail
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || './playwright/session';
const MARKETPLACE_LOCATION = process.env.MARKETPLACE_LOCATION || 'Rome, Italy';
const MARKETPLACE_RADIUS_KM = parseInt(process.env.MARKETPLACE_RADIUS_KM) || 10;

// Parse arguments
const args = process.argv.slice(2);
const categoryArg = args.find(a => a.startsWith('--category='));
const category = categoryArg ? categoryArg.split('=')[1] : 'both';
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 10;
const visitDetail = !args.includes('--no-detail');

const CATEGORIES = category === 'both'
  ? ['propertyrentals', 'propertyforsale']
  : [category];

if (!['propertyrentals', 'propertyforsale', 'both'].includes(category)) {
  console.error('Invalid --category. Use: propertyrentals, propertyforsale, or both');
  process.exit(1);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}

async function humanMove(page) {
  const x = Math.floor(Math.random() * 800) + 100;
  const y = Math.floor(Math.random() * 400) + 100;
  await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
}

async function scrollDown(page) {
  const multiplier = 1.2 + Math.random() * 1.3;
  await page.evaluate((mult) => {
    window.scrollBy(0, window.innerHeight * mult);
  }, multiplier);
}

async function setLocationFilter(page) {
  try {
    console.log(`  Setting location: ${MARKETPLACE_LOCATION}, radius: ${MARKETPLACE_RADIUS_KM}km`);

    const locationInput = await page.$(
      'input[placeholder*="ocation" i], input[aria-label*="ocation" i]'
    );

    if (locationInput) {
      await locationInput.click();
      await delay(500);
      await locationInput.fill('');
      await delay(300);

      for (const char of MARKETPLACE_LOCATION) {
        await locationInput.type(char, { delay: 50 + Math.random() * 100 });
      }

      await delay(2000);

      const suggestion = await page.$(
        '[role="listbox"] [role="option"]:first-child, [role="listbox"] li:first-child'
      );
      if (suggestion) {
        await suggestion.click();
        await delay(1000);
      } else {
        await locationInput.press('ArrowDown');
        await delay(300);
        await locationInput.press('Enter');
        await delay(1000);
      }

      // Try radius selector
      const radiusSelect = await page.$(
        'select[aria-label*="adius" i], [role="combobox"][aria-label*="adius" i]'
      );
      if (radiusSelect) {
        await radiusSelect.click();
        await delay(500);
        // Pick closest option to target radius
        const picked = await page.evaluate((targetKm) => {
          const options = document.querySelectorAll('[role="option"], select option');
          let best = null;
          let bestDiff = Infinity;
          for (const opt of options) {
            const text = opt.textContent?.trim() || '';
            const km = parseInt(text.match(/\d+/)?.[0] || '0');
            const diff = Math.abs(km - targetKm);
            if (diff < bestDiff && km > 0) {
              bestDiff = diff;
              best = opt;
            }
          }
          if (best) best.click();
          return best ? best.textContent?.trim() : null;
        }, MARKETPLACE_RADIUS_KM);
        if (picked) console.log(`  Radius set to: ${picked}`);
        await delay(500);
      }

      // Apply button
      const applyBtn = await page.$(
        'div[role="dialog"] button:has-text("Apply"), div[role="dialog"] button:has-text("Search"), div[role="dialog"] button:has-text("Applica")'
      );
      if (applyBtn) {
        await applyBtn.click();
        await delay(1500);
      }

      console.log('  Location filter applied');
    } else {
      console.log('  [WARN] Location input not found, skipping filter');
    }
  } catch (error) {
    console.log(`  [WARN] Location filter failed: ${error.message}`);
  }
}

async function collectCards(page, maxCards) {
  const collected = new Map();
  let noNewCount = 0;
  let scrollCount = 0;

  while (collected.size < maxCards && noNewCount < 5) {
    scrollCount++;
    const cards = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/marketplace/item/"]');

      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        const fullUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
        const idMatch = fullUrl.match(/\/marketplace\/item\/(\d+)/);
        if (!idMatch) return;

        results.push({
          post_id: idMatch[1],
          post_url: fullUrl,
          card_text: (link.textContent || '').trim().substring(0, 2000),
        });
      });

      return results;
    });

    let newCount = 0;
    for (const card of cards) {
      if (!collected.has(card.post_id)) {
        collected.set(card.post_id, card);
        newCount++;
      }
    }

    console.log(`  Scroll #${scrollCount}: ${newCount} new, ${collected.size} total`);

    if (newCount === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (collected.size < maxCards) {
      await scrollDown(page);
      await randomDelay(1000, 2500);
    }
  }

  return Array.from(collected.values()).slice(0, maxCards);
}

async function extractDetail(page) {
  return await page.evaluate(() => {
    const result = {
      description: '',
      price: '',
      location: '',
      seller_name: '',
      seller_profile_url: '',
      full_text: '',
      all_links: [],
    };

    // Collect all links with their text + href
    const allLinks = document.querySelectorAll('a[href]');
    allLinks.forEach(a => {
      const text = (a.textContent || '').trim();
      const href = a.getAttribute('href') || '';
      if (text && text.length >= 2 && text.length <= 100) {
        result.all_links.push({ text, href });
      }
    });

    // Get full page text
    const main = document.querySelector('[role="main"]');
    result.full_text = main ? main.innerText : document.body.innerText;

    const lines = result.full_text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // --- Seller extraction ---
    // Marketplace seller links match /marketplace/profile/{user_id}/
    // The name is in the link text (e.g. "Feroz Hussain"), NOT "Seller details"
    for (const link of result.all_links) {
      if (/\/marketplace\/profile\/\d+/.test(link.href)) {
        // Skip "Seller details" / "Dettagli venditore" UI labels
        if (/^(seller details|dettagli venditore)$/i.test(link.text)) continue;
        if (link.text.length >= 3 && link.text.length <= 80 && /^[A-ZÀ-ÿ]/.test(link.text)) {
          result.seller_name = link.text;
          let url = link.href.split('?')[0];
          if (url.startsWith('/')) url = 'https://www.facebook.com' + url;
          result.seller_profile_url = url;
          break;
        }
      }
    }

    // Fallback: look for /user/ or profile.php links
    if (!result.seller_name) {
      for (const link of result.all_links) {
        if (/\/user\/\d+/.test(link.href) || /profile\.php\?id=/.test(link.href)) {
          if (link.text.length >= 3 && link.text.length <= 80) {
            result.seller_name = link.text;
            result.seller_profile_url = link.href;
            break;
          }
        }
      }
    }

    // --- Price extraction ---
    for (const line of lines.slice(0, 10)) {
      if (/^[\$€£]/.test(line) || /^\d[\d,]*(\.\d{2})?$/.test(line) || /\bEUR|USD|GBP|PKR\b/i.test(line)) {
        result.price = line;
        break;
      }
    }
    if (!result.price) {
      const m = result.full_text.match(/(?:\$|€|£|PKR|EUR|USD)\s*[\d,]+(?:\.\d{2})?|[\d,]+\s*(?:€|EUR)/i);
      if (m) result.price = m[0];
    }

    // --- Find the seller section boundary in text ---
    const sellerIdx = lines.findIndex(l =>
      /^(informazioni sul venditore|seller information|about (?:the )?seller|sold by|listed by)/i.test(l)
    );
    const descriptionEnd = sellerIdx >= 0 ? sellerIdx : lines.length;

    // --- Description extraction ---
    // Page structure: ... "Description" heading, then actual text, then "Sponsored" or "Seller information"
    // Also filter UI labels: "Home sales", "Home Location", "Location is approximate", "Message"
    const uiPatterns = /^(like|share|save|comment|report|message|learn more|see more|interested|available|sold|notifications|seller details|dettagli venditore|home sales|home rentals|home location|location is approximate|\d+\s*(people|person))/i;

    // Find the "Description" heading line
    const descHeadingIdx = lines.findIndex(l => /^description$/i.test(l));

    if (descHeadingIdx >= 0) {
      // Take everything between "Description" and "Sponsored" / "Seller information"
      const descLines = [];
      for (let i = descHeadingIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^(sponsored|seller information|informazioni sul venditore|about (?:the )?seller)$/i.test(line)) break;
        if (uiPatterns.test(line)) continue;
        if (line.length < 3) continue;
        descLines.push(line);
      }
      if (descLines.length > 0) {
        result.description = descLines.join('\n').substring(0, 5000);
      }
    }

    // Fallback: if no "Description" heading found, take lines between price and seller section
    if (!result.description) {
      const descLines = [];
      let pastHeader = false;
      for (let i = 0; i < descriptionEnd; i++) {
        const line = lines[i];
        if (uiPatterns.test(line)) continue;
        if (line === result.price) continue;
        if (line === result.seller_name) continue;
        if (/^(home sales|home rentals|home location|location is approximate|description)$/i.test(line)) continue;
        if (line.length < 3) continue;
        if (!pastHeader) {
          if (line.length >= 10) { pastHeader = true; descLines.push(line); }
          continue;
        }
        descLines.push(line);
      }
      if (descLines.length > 0) {
        result.description = descLines.join('\n').substring(0, 5000);
      }
    }

    // --- Location extraction ---
    for (const line of lines.slice(0, 15)) {
      if (line.length >= 3 && line.length <= 120 &&
          line !== result.price && line !== result.seller_name &&
          !uiPatterns.test(line)) {
        if (/^[A-ZÀ-ÿ]/.test(line) && (line.includes(',') || /^[A-ZÀ-ÿ\s]+$/.test(line)) && line.length < 80) {
          result.location = line;
          break;
        }
      }
    }

    return result;
  });
}

function parseCardText(cardText) {
  const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Price is usually the first or second line with a currency symbol
  let price = null;
  const pricePatterns = [
    /\$[\d,]+(?:\.\d{2})?/,
    /€[\d,]+(?:\.\d{2})?/,
    /[\d,]+\s*(?:EUR|USD|GBP|€|\$)/i,
    /(?:EUR|USD|GBP|€|\$)\s*[\d,]+/i,
  ];
  for (const line of lines.slice(0, 5)) {
    for (const p of pricePatterns) {
      const m = line.match(p);
      if (m) { price = m[0]; break; }
    }
    if (price) break;
  }

  // Title: first line that looks like a title
  let title = null;
  for (const line of lines) {
    if (line.length >= 10 && line.length <= 200 && line.split(/\s+/).length >= 2 && !line.match(/^[\$\€]/)) {
      title = line;
      break;
    }
  }

  // Location: usually a short line after price
  let location = null;
  for (const line of lines.slice(1, 6)) {
    if (line.length >= 3 && line.length <= 100 && line !== price && line !== title) {
      if (/^[A-Z]/.test(line) && line.split(',').length <= 3) {
        location = line;
        break;
      }
    }
  }

  return { price, title, location };
}

async function main() {
  console.log('=== Marketplace Scraper Test ===');
  console.log(`Categories: ${CATEGORIES.join(', ')}`);
  console.log(`Limit: ${limit} per category`);
  console.log(`Location: ${MARKETPLACE_LOCATION}`);
  console.log(`Radius: ${MARKETPLACE_RADIUS_KM}km`);
  console.log(`Visit detail pages: ${visitDetail}`);
  console.log('');

  console.log('Initializing browser...');
  const context = await chromium.launchPersistentContext(
    path.resolve(SESSION_PATH),
    {
      headless: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      locale: 'en-US',
      permissions: ['clipboard-read', 'clipboard-write'],
    }
  );

  try {
    for (const cat of CATEGORIES) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`CATEGORY: ${cat}`);
      console.log('='.repeat(60));

      const page = await context.newPage();
      const url = `https://www.facebook.com/marketplace/category/${cat}`;
      console.log(`Navigating to: ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(3000);
      await humanMove(page);

      // Check login
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
        console.error('Login required! Run: node scripts/setup-session.js');
        await page.close();
        continue;
      }

      await setLocationFilter(page);
      await randomDelay(1500, 3000);

      console.log(`\nCollecting cards (max ${limit})...`);
      const cards = await collectCards(page, limit);
      console.log(`Found ${cards.length} cards\n`);

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const parsed = parseCardText(card.card_text);

        console.log(`\n--- Card #${i + 1} ---`);
        console.log(`  Post ID: ${card.post_id}`);
        console.log(`  URL: ${card.post_url}`);
        console.log(`  Title: ${parsed.title || 'N/A'}`);
        console.log(`  Price: ${parsed.price || 'N/A'}`);
        console.log(`  Location: ${parsed.location || 'N/A'}`);
        console.log(`  Card text preview: ${card.card_text.substring(0, 150)}...`);

        if (visitDetail) {
          console.log(`\n  Visiting detail page...`);
          try {
            await page.goto(card.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);

            const detail = await extractDetail(page);

            console.log(`  [DETAIL] Price: ${detail.price || 'N/A'}`);
            console.log(`  [DETAIL] Location: ${detail.location || 'N/A'}`);
            console.log(`  [DETAIL] Seller: ${detail.seller_name || 'N/A'}`);
            console.log(`  [DETAIL] Seller URL: ${detail.seller_profile_url || 'N/A'}`);
            console.log(`  [DETAIL] Description: ${(detail.description || 'N/A').substring(0, 300)}...`);

            // Always dump debug info for first card
            if (i === 0) {
              // Save screenshot
              const fs = require('fs');
              const screenshotPath = `./marketplace_debug_card${i + 1}.png`;
              await page.screenshot({ path: screenshotPath, fullPage: false });
              console.log(`\n  [DEBUG] Screenshot saved: ${screenshotPath}`);

              // Save HTML dump
              const html = await page.evaluate(() => {
                const main = document.querySelector('[role="main"]');
                return main ? main.innerHTML : document.body.innerHTML;
              });
              fs.writeFileSync(`./marketplace_debug_card${i + 1}.html`, html);
              console.log(`  [DEBUG] HTML saved: marketplace_debug_card${i + 1}.html`);

              // Dump raw text
              console.log(`\n  [DEBUG] Full page text:`);
              console.log(detail.full_text.split('\n').map(l => `    ${l}`).join('\n'));

              // Dump all links
              console.log(`\n  [DEBUG] All links on page:`);
              detail.all_links.forEach(l => {
                console.log(`    "${l.text}" -> ${l.href.substring(0, 100)}`);
              });
            }

            // Build the payload that would be sent to the API
            const nameParts = (detail.seller_name || '').trim().split(/\s+/);
            const listingType = cat === 'propertyrentals' ? 'rent' : 'sale';
            const payload = {
              agency_id: parseInt(process.env.DEFAULT_AGENCY_ID) || 1,
              group: { facebook_group_id: 'marketplace', name: 'Facebook Marketplace' },
              post: {
                facebook_post_id: card.post_id,
                author_name: detail.seller_name || '',
                author_profile_url: detail.seller_profile_url || '',
                message: (detail.description || card.card_text).substring(0, 5000),
                post_type: listingType === 'rent' ? 'rent_offer' : 'selling',
                property_type: 'residential',
                permalink: card.post_url,
              },
              prospect_contact: {
                first_name: nameParts[0] || '',
                last_name: nameParts.slice(1).join(' ') || '',
                phone: '',
                email: '',
                force: false,
              },
              news_lead: {
                title: parsed.title || '',
                description: (detail.description || '').substring(0, 5000),
                address: detail.location || parsed.location || '',
                estimated_price: detail.price ? parseFloat(detail.price.replace(/[^0-9.]/g, '')) || null : null,
                property_type: 'residential',
              },
            };

            console.log(`\n  [API PAYLOAD]`);
            console.log(JSON.stringify(payload, null, 2).split('\n').map(l => `  ${l}`).join('\n'));

          } catch (err) {
            console.log(`  [ERROR] Failed to get detail: ${err.message}`);
          }

          await randomDelay(2000, 4000);
        }
      }

      await page.close();

      if (CATEGORIES.indexOf(cat) < CATEGORIES.length - 1) {
        console.log('\nWaiting before next category...');
        await randomDelay(3000, 6000);
      }
    }

    console.log(`\n\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Categories scraped: ${CATEGORIES.length}`);
    console.log(`\nNOTE: No data was saved to DB or sent to the external API.`);
    console.log('To scrape for real, set MARKETPLACE_ENABLED=true and run the app.');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await context.close();
  }
}

main().catch(console.error);
